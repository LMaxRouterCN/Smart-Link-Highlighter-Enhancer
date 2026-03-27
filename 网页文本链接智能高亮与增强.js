// ==UserScript==
// @name        网页文本链接智能高亮与增强
// @namespace   http://tampermonkey.net/
// @version     2.9
// @description 智能识别文本链接，移除悬停时的额外透明度，确保颜色显示准确，修复样式继承问题。
// @author      LMaxRouterCN
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       GM_xmlhttpRequest
// @connect     *
// @run-at      document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. 配置项管理
    // ==========================================
    const defaultConfig = {
        listMode: 'blacklist',
        urlList: [],
        openInNewTab: true,
        conflictStrategy: 'yield',
        enableTitleFetch: false,
        titleFilterRegex: '',
        styles: {
            default: {
                textColorEnabled: true,
                textColor: '#77c2ff',
                borderEnabled: false,
                borderColor: '#ff0000',
                borderRadius: 0,
                borderWidth: 2,
                borderOffset: 0,
                underlineEnabled: true,
                italicEnabled: false,
                boldEnabled: false
            },
            hover: {
                textColorEnabled: true,
                textColor: '#ff9900',
                borderEnabled: false,
                borderColor: '#ff9900',
                borderRadius: 0,
                borderWidth: 2,
                borderOffset: 0,
                underlineEnabled: false,
                italicEnabled: false,
                boldEnabled: true
            }
        }
    };

    let savedConfig = GM_getValue('linkConfig', {});
    const deepMerge = (target, source) => {
        for (let key in source) {
            if (source[key] instanceof Object && key in target) {
                target[key] = deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    };
    let config = deepMerge(JSON.parse(JSON.stringify(defaultConfig)), savedConfig);

    const saveConfig = () => {
        GM_setValue('linkConfig', config);
    };

    // ==========================================
    // 2. 黑白名单检查逻辑
    // ==========================================
    const checkIsEnabled = () => {
        const currentUrl = window.location.href;
        const list = config.urlList || [];
        const isInList = list.some(item => currentUrl.includes(item));
        if (config.listMode === 'whitelist') return isInList;
        return !isInList;
    };

    // ==========================================
    // 3. 样式注入
    // ==========================================
    const styleId = 'smart-link-highlight-styles';
    const applyStyles = () => {
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
        }
        const generateCss = (styleConfig) => {
            let css = '';
            if (styleConfig.textColorEnabled) css += `color: ${styleConfig.textColor} !important;`;

            // 边框样式生成 (使用 outline)
            if (styleConfig.borderEnabled) {
                css += `outline: ${styleConfig.borderWidth}px solid ${styleConfig.borderColor};`;
                css += `outline-offset: ${styleConfig.borderOffset}px;`;
                css += `border-radius: ${styleConfig.borderRadius}px;`;
            } else {
                css += `outline: none;`;
            }

            // 下划线
            if (styleConfig.underlineEnabled) css += `text-decoration: underline;`;
            else css += `text-decoration: none;`;

            // 斜体：显式重置
            if (styleConfig.italicEnabled) css += `font-style: italic;`;
            else css += `font-style: normal;`;

            // 加粗：显式重置
            if (styleConfig.boldEnabled) css += `font-weight: bold;`;
            else css += `font-weight: normal;`;

            return css;
        };
        let baseCss = `
            .smart-link-wrapper {
                cursor: pointer;
                margin: 0 2px;
                padding: 0 2px;
                display: inline-block;
                transition: all 0.2s;
                box-decoration-break: clone;
                -webkit-box-decoration-break: clone;
                ${generateCss(config.styles.default)}
            }
        `;
        let hoverCss = `
            .smart-link-wrapper:hover {
                /* v2.9: 移除了 opacity: 0.9; 确保颜色纯度 */
                ${generateCss(config.styles.hover)}
            }
        `;
        styleEl.textContent = baseCss + hoverCss;
    };

    // ==========================================
    // 4. 标题获取与过滤功能
    // ==========================================
    const titleCache = new Map();
    const parseRegexString = (regexStr) => {
        if (!regexStr) return null;
        try {
            const match = regexStr.match(/^\/(.+)\/([gimsuy]*)$/);
            if (match) return new RegExp(match[1], match[2]);
            return new RegExp(regexStr, 'g');
        } catch (e) {
            return null;
        }
    };
    const fetchTitle = (url, element) => {
        if (titleCache.has(url)) {
            const title = titleCache.get(url);
            if (title) applyFilteredTitle(title, element);
            return;
        }
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            onload: function(response) {
                const matches = response.responseText.match(/<title>([^<]*)<\/title>/i);
                if (matches && matches[1]) {
                    let title = matches[1].trim();
                    titleCache.set(url, title);
                    applyFilteredTitle(title, element);
                } else {
                    titleCache.set(url, null);
                }
            },
            onerror: function() {}
        });
    };
    const applyFilteredTitle = (title, element) => {
        let finalTitle = title;
        const regex = parseRegexString(config.titleFilterRegex);
        if (regex) finalTitle = title.replace(regex, '').trim();
        if (finalTitle && finalTitle.length > 0) {
            element.textContent = finalTitle;
            element.title = `原标题: ${title}\n链接: ${element.dataset.href || ''}`;
        }
    };

    // ==========================================
    // 5. 核心逻辑：文本节点处理
    // ==========================================
    const urlRegex = /((?:https?:\/\/|www\.)[^\s<>"'\u3000-\u303F\uFF00-\uFFEF]+)/gi;

    const stripTrailingPunctuation = (url) => {
        const pairs = { ')': '(', ']': '[', '}': '{' };
        const simpleSeparators = [',', ';', ':', '!', '?', '.'];
        let cleanUrl = url;

        while (cleanUrl.length > 0) {
            const lastChar = cleanUrl[cleanUrl.length - 1];

            if (pairs[lastChar]) {
                const openChar = pairs[lastChar];
                const openCount = (cleanUrl.match(new RegExp('\\' + openChar, 'g')) || []).length;
                const closeCount = (cleanUrl.match(new RegExp('\\' + lastChar, 'g')) || []).length;

                if (openCount >= closeCount) {
                    break;
                } else {
                    cleanUrl = cleanUrl.slice(0, -1);
                    continue;
                }
            }

            if (simpleSeparators.includes(lastChar)) {
                cleanUrl = cleanUrl.slice(0, -1);
                continue;
            }

            break;
        }
        return cleanUrl;
    };

    const processTextNode = (textNode) => {
        const parentTag = textNode.parentNode.tagName;
        if (['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'A'].includes(parentTag)) return;
        if (textNode.parentNode.classList.contains('smart-link-wrapper')) return;

        const textContent = textNode.textContent;
        const matches = [...textContent.matchAll(urlRegex)];
        if (matches.length === 0) return;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;

        matches.forEach(match => {
            const rawUrl = match[0];
            const index = match.index;

            if (index > lastIndex) fragment.appendChild(document.createTextNode(textContent.slice(lastIndex, index)));

            const cleanUrl = stripTrailingPunctuation(rawUrl);
            const trailingChars = rawUrl.slice(cleanUrl.length);

            if (cleanUrl.length < 4) {
                fragment.appendChild(document.createTextNode(rawUrl));
                lastIndex = index + rawUrl.length;
                return;
            }

            const wrapper = document.createElement('span');
            wrapper.className = 'smart-link-wrapper';
            wrapper.textContent = cleanUrl;

            let href = cleanUrl;
            if (href.startsWith('www.')) href = 'http://' + href;
            wrapper.dataset.href = href;

            wrapper.addEventListener('click', (e) => {
                e.stopPropagation();
                if (config.openInNewTab) window.open(href, '_blank');
                else window.location.href = href;
            });

            fragment.appendChild(wrapper);

            if (trailingChars.length > 0) {
                fragment.appendChild(document.createTextNode(trailingChars));
            }

            if (config.enableTitleFetch) fetchTitle(href, wrapper);
            lastIndex = index + rawUrl.length;
        });

        if (lastIndex < textContent.length) fragment.appendChild(document.createTextNode(textContent.slice(lastIndex)));
        textNode.parentNode.replaceChild(fragment, textNode);
    };

    const processExistingLinks = () => {
        if (config.conflictStrategy !== 'override') return;
        document.querySelectorAll('a').forEach(aTag => {
            if (aTag.dataset.smartProcessed === 'true') return;
            aTag.dataset.smartProcessed = 'true';

            if (urlRegex.test(aTag.textContent)) {
                const span = document.createElement('span');
                span.innerHTML = aTag.innerHTML;
                for (let attr of aTag.attributes) {
                    if (attr.name !== 'href') span.setAttribute(attr.name, attr.value);
                }
                span.className += ' smart-link-override';
                aTag.parentNode.replaceChild(span, aTag);
                walk(span);
            }
        });
    };

    const walk = (root) => {
        const hasStyles = config.styles.default.textColorEnabled || config.styles.default.borderEnabled || config.styles.default.underlineEnabled || config.styles.default.italicEnabled || config.styles.default.boldEnabled;
        if (!hasStyles && !config.enableTitleFetch) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        let node;
        const textNodes = [];
        while (node = walker.nextNode()) textNodes.push(node);
        textNodes.forEach(processTextNode);
    };

    const processAll = () => {
        processExistingLinks();
        walk(document.body);
    };

    // ==========================================
    // 6. 动态监听
    // ==========================================
    let observer = null;
    const startObserver = () => {
        if(observer) return;
        observer = new MutationObserver((mutations) => {
            const hasStyles = config.styles.default.textColorEnabled || config.styles.default.borderEnabled;
            if (!hasStyles && !config.enableTitleFetch) return;
            for (let mutation of mutations) {
                for (let node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) walk(node);
                    else if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    // ==========================================
    // 7. 配置面板 UI
    // ==========================================
    const createPanel = () => {
        if (document.getElementById('smart-link-config-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'smart-link-config-panel';
        const urlListText = (config.urlList || []).join('\n');

        const genRow = (labelText, key, group, w = '50%') => {
            const conf = config.styles[group];
            const enabledKey = key + 'Enabled';
            const valueKey = key;
            const isActuallyToggleOnly = (key === 'underline' || key === 'italic' || key === 'bold');

            const inputStyle = `background: #444; color: #fff; border: 1px solid #666;`;

            let html = `<div style="width: ${w}; display: inline-block; vertical-align: top; padding-right: 5px; box-sizing: border-box; margin-bottom: 4px;">`;
            html += `<label style="font-size:12px; color: #ddd;"><input type="checkbox" class="cfg-toggle" data-group="${group}" data-key="${key}" ${conf[enabledKey] ? 'checked' : ''}> ${labelText}</label>`;

            if (!isActuallyToggleOnly) {
                 if (key === 'borderRadius' || key === 'borderWidth' || key === 'borderOffset') {
                     html += `<input type="number" class="cfg-num" data-group="${group}" data-key="${key}" value="${conf[valueKey]}" style="width:50px; font-size:12px; ${inputStyle}" title="数值">`;
                 } else {
                     html += `<input type="color" class="cfg-color" data-group="${group}" data-key="${key}" value="${conf[valueKey]}" style="width:30px; height:20px; vertical-align: middle; float:right; cursor:pointer;">`;
                 }
            }
            html += `</div>`;
            return html;
        };

        const genBorderDetailRow = (group) => {
            return `
            <div style="margin-top: 4px; display: flex; justify-content: space-between;">
                ${genRow('圆角', 'borderRadius', group, '33%')}
                ${genRow('厚度', 'borderWidth', group, '33%')}
                ${genRow('偏移', 'borderOffset', group, '33%')}
            </div>
            <div style="font-size: 10px; color: #aaa; margin-top: 2px; margin-bottom: 4px;">偏移: 正数外扩，负数内缩</div>
            `;
        };

        panel.innerHTML = `
            <div style="position: fixed; top: 10px; right: 10px; background: #2b2b2b; border: 1px solid #555; padding: 15px; z-index: 99999; box-shadow: 0 0 15px rgba(0,0,0,0.5); font-family: sans-serif; font-size: 14px; border-radius: 8px; width: 400px; max-height: 90vh; overflow-y: auto; color: #eee;">
                <h3 style="margin: 0 0 10px; font-size: 16px; color: #fff; border-bottom: 1px solid #444; padding-bottom: 8px;">链接增强设置 v2.9</h3>

                <!-- 样式配置区域 -->
                <div style="background: #333; border: 1px solid #444; padding: 8px; border-radius: 4px; margin-bottom: 10px;">
                    <div style="font-weight: bold; margin-bottom: 8px; color: #fff;">🎨 样式配置</div>

                    <!-- 默认状态 -->
                    <div style="margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 8px;">
                        <div style="font-size: 12px; color: #aaa; margin-bottom: 5px;">■ 默认状态:</div>
                        <div style="background: #3a3a3a; padding: 6px; border-radius: 3px;">
                            ${genRow('文本颜色', 'textColor', 'default')}
                            <div style="width: 100%; height: 1px; background: #444; margin: 6px 0;"></div>
                            ${genRow('边框颜色', 'border', 'default')}
                            ${genBorderDetailRow('default')}
                            <div style="width: 100%; height: 1px; background: #444; margin: 6px 0;"></div>
                            <div style="display: flex; justify-content: space-between;">
                                ${genRow('下划线', 'underline', 'default', '33%')}
                                ${genRow('斜体', 'italic', 'default', '33%')}
                                ${genRow('加粗', 'bold', 'default', '33%')}
                            </div>
                        </div>
                    </div>

                    <!-- 悬停状态 -->
                    <div>
                        <div style="font-size: 12px; color: #aaa; margin-bottom: 5px;">■ 光标悬停时:</div>
                        <div style="background: #3a3a3a; padding: 6px; border-radius: 3px;">
                            ${genRow('文本颜色', 'textColor', 'hover')}
                            <div style="width: 100%; height: 1px; background: #444; margin: 6px 0;"></div>
                            ${genRow('边框颜色', 'border', 'hover')}
                            ${genBorderDetailRow('hover')}
                            <div style="width: 100%; height: 1px; background: #444; margin: 6px 0;"></div>
                            <div style="display: flex; justify-content: space-between;">
                                ${genRow('下划线', 'underline', 'hover', '33%')}
                                ${genRow('斜体', 'italic', 'hover', '33%')}
                                ${genRow('加粗', 'bold', 'hover', '33%')}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 黑白名单区域 -->
                <div style="background: #333; padding: 8px; border-radius: 4px; margin-bottom: 10px; border: 1px solid #444;">
                    <div style="margin-bottom: 5px; font-weight: bold; color: #fff;">🚫 网站过滤规则：</div>
                    <div style="margin-bottom: 5px; color: #ddd;">
                        <label><input type="radio" name="listMode" value="blacklist" ${config.listMode === 'blacklist' ? 'checked' : ''}> 黑名单</label>
                        <label style="margin-left: 10px;"><input type="radio" name="listMode" value="whitelist" ${config.listMode === 'whitelist' ? 'checked' : ''}> 白名单</label>
                    </div>
                    <textarea id="cfg-urllist" style="width: 100%; height: 50px; font-size: 12px; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555;" placeholder="每行一个域名">${urlListText}</textarea>
                    <div style="margin-top: 5px; display: flex; justify-content: space-between; align-items: center;">
                        <div style="font-size: 11px; color: #888;">支持域名或URL片段，保存后刷新生效。</div>
                        <button id="cfg-add-this" style="font-size: 12px; padding: 2px 6px; cursor: pointer; background: #555; color: #fff; border: 1px solid #777;">加入当前网站</button>
                    </div>
                </div>

                <!-- 高级功能 -->
                <div style="border-top: 1px dashed #555; padding-top: 8px; margin-bottom: 8px;">
                    <label style="font-weight: bold; color: #fff;"><input type="checkbox" id="cfg-title-fetch" ${config.enableTitleFetch ? 'checked' : ''}> 获取网页标题替换文本</label>
                    <div style="margin-top: 5px; background: #333; padding: 8px; border-radius: 4px;">
                        <label style="font-size: 12px; display: block; margin-bottom: 3px; color: #ddd;">标题过滤正则表达式:</label>
                        <input type="text" id="cfg-title-regex" value="${config.titleFilterRegex}" placeholder="点击下方常用规则自动填入" style="width: 100%; box-sizing: border-box; padding: 2px; background: #444; color: #fff; border: 1px solid #555;">
                        <div style="margin-top: 6px; border-top: 1px solid #444; padding-top: 6px;">
                            <div style="font-size: 11px; color: #ccc; margin-bottom: 4px;">常用规则 (点击填入)：</div>
                            <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                                <button class="regex-preset" data-regex="/\s*[-_|]\s*.*$/">移除网站后缀</button>
                                <button class="regex-preset" data-regex="/[(\s\[【].*?[)\s]】]/g">移除括号内容</button>
                                <button class="regex-preset" data-regex="/\s*-\s*豆瓣.*/">移除豆瓣后缀</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div style="margin-bottom: 8px; color: #ddd;">
                    <label><input type="checkbox" id="cfg-newtab" ${config.openInNewTab ? 'checked' : ''}> 新标签页打开</label>
                </div>
                <div style="margin-bottom: 8px; color: #ddd;">
                    <span>冲突策略:</span><br>
                    <label style="font-size: 12px;"><input type="radio" name="conflict" value="yield" ${config.conflictStrategy === 'yield' ? 'checked' : ''}> 让步(保留原链接)</label><br>
                    <label style="font-size: 12px;"><input type="radio" name="conflict" value="override" ${config.conflictStrategy === 'override' ? 'checked' : ''}> 覆盖(使用脚本样式)</label>
                </div>
                <button id="cfg-close" style="margin-top: 5px; padding: 6px 10px; cursor: pointer; width: 100%; background: #555; color: #fff; border: 1px solid #777; font-weight: bold;">关闭面板</button>
            </div>
            <style>
                .regex-preset { font-size: 10px; background: #444; border: 1px solid #666; color: #ddd; padding: 2px 5px; border-radius: 3px; cursor: pointer; }
                .regex-preset:hover { background: #666; border-color: #888; color: #fff; }
            </style>
        `;
        document.body.appendChild(panel);

        // --- 事件绑定逻辑 ---
        const bindStyleEvents = () => {
            panel.querySelectorAll('.cfg-toggle').forEach(chk => {
                chk.onchange = (e) => {
                    const group = e.target.dataset.group;
                    const key = e.target.dataset.key;
                    const enabledKey = key + 'Enabled';
                    config.styles[group][enabledKey] = e.target.checked;
                    saveConfig();
                    applyStyles();
                };
            });
            panel.querySelectorAll('.cfg-color').forEach(input => {
                input.oninput = (e) => {
                    const group = e.target.dataset.group;
                    const key = e.target.dataset.key;
                    config.styles[group][key] = e.target.value;
                    saveConfig();
                    applyStyles();
                };
            });
            panel.querySelectorAll('.cfg-num').forEach(input => {
                input.oninput = (e) => {
                    const group = e.target.dataset.group;
                    const key = e.target.dataset.key;
                    let val = parseInt(e.target.value, 10);
                    if (isNaN(val)) val = 0;
                    config.styles[group][key] = val;
                    saveConfig();
                    applyStyles();
                };
            });
        };
        bindStyleEvents();

        document.querySelectorAll('input[name="listMode"]').forEach(radio => {
            radio.onchange = (e) => { config.listMode = e.target.value; saveConfig(); };
        });
        document.getElementById('cfg-urllist').onchange = (e) => {
            config.urlList = e.target.value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            saveConfig();
        };
        document.getElementById('cfg-add-this').onclick = () => {
            const domain = window.location.hostname;
            if (domain && !config.urlList.includes(domain)) {
                config.urlList.push(domain); saveConfig();
                document.getElementById('cfg-urllist').value = config.urlList.join('\n');
                alert(`已添加 ${domain}，刷新页面生效。`);
            } else { alert('域名无效或已存在'); }
        };

        document.getElementById('cfg-title-fetch').onchange = (e) => {
            config.enableTitleFetch = e.target.checked; saveConfig();
            if(config.enableTitleFetch) processAll();
        };
        document.getElementById('cfg-title-regex').onchange = (e) => {
            config.titleFilterRegex = e.target.value; saveConfig();
            titleCache.clear(); processAll();
        };
        document.querySelectorAll('.regex-preset').forEach(btn => {
            btn.onclick = (e) => {
                const regexVal = e.target.getAttribute('data-regex');
                document.getElementById('cfg-title-regex').value = regexVal;
                config.titleFilterRegex = regexVal; saveConfig();
                titleCache.clear(); processAll();
            };
        });
        document.getElementById('cfg-newtab').onchange = (e) => { config.openInNewTab = e.target.checked; saveConfig(); };
        document.querySelectorAll('input[name="conflict"]').forEach(radio => {
            radio.onchange = (e) => { config.conflictStrategy = e.target.value; saveConfig(); alert("冲突策略已更改，建议刷新页面。"); };
        });
        document.getElementById('cfg-close').onclick = () => panel.remove();
    };

    GM_registerMenuCommand("⚙️ 链接增强设置", createPanel);

    // ==========================================
    // 8. 初始化
    // ==========================================
    const init = () => {
        if (!checkIsEnabled()) return;
        applyStyles();
        processAll();
        startObserver();
    };

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
