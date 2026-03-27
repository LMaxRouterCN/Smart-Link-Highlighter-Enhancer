// ==UserScript==
// @name        网页文本链接智能高亮与增强
// @namespace   http://tampermonkey.net/
// @version     3.6
// @description 智能识别文本链接，新增防抖、显示截断、排除类名、Unicode域名等深度开发者选项。
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
        },
        // 开发人员选项
        devSettings: {
            strictHttpMode: false,
            allowedTLDs: 'com|net|org|cn|io|co|ai|gov|edu|info|xyz|top|cc|me|tv|biz|site|online|vip|cloud|tech|fun|wiki|design|live',
            trimChars: '.,;:!?()（）【】',
            stopChars: '<>"\'',
            excludeChinesePunctuation: true,
            excludeTags: 'SCRIPT,STYLE,TEXTAREA,INPUT,CODE,A,NOSCRIPT',
            minLinkLength: 4,
            defaultProtocol: 'http://',
            titleFetchTimeout: 3000,
            titleCacheLimit: 100,

            // 核心正则参数
            protocols: 'https?:\\/\\/',
            prefixes: 'www\\.',
            domainChars: 'a-zA-Z0-9-',
            enableIpMatch: false,
            enableLocalhostMatch: false,
            titleFetchRegex: '/<title>([^<]*)<\\/title>/i',

            // 新增深度选项
            debounceDelay: 200,       // 防抖延迟
            maxDisplayLength: 0,      // 最大显示长度 (0为不限)
            excludeClassNames: '',    // 排除的类名
            allowUnicodeDomains: false // 允许中文/国际化域名
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
    // 2. 动态正则编译 (核心逻辑)
    // ==========================================
    let urlRegex = null;

    const compileRegex = () => {
        const dev = config.devSettings;

        // 1. 基础字符集定义
        const stopCharsEscaped = dev.stopChars.split('').map(c => '\\' + c).join('');
        let chinesePunctuationRange = '';
        if (dev.excludeChinesePunctuation) {
            chinesePunctuationRange = '\u3000-\u303F\uFF00-\uFFEF';
        }
        const exclusionSet = `[^\\s${stopCharsEscaped}${chinesePunctuationRange}]`;

        // 域名主体字符集
        let domainChars = dev.domainChars;
        if (dev.allowUnicodeDomains) {
            // 扩展域名允许字符范围，包含常见非拉丁字符
            domainChars += '\\u0080-\\uFFFF';
        }

        // 2. 构建正则部分
        let patternParts = [];

        // 部分 A: 协议与前缀
        const hasProtocol = dev.protocols && dev.protocols.trim().length > 0;
        const hasPrefix = dev.prefixes && dev.prefixes.trim().length > 0;

        if (hasProtocol || hasPrefix) {
            let prefixGroup = '';
            if (hasProtocol && hasPrefix) {
                prefixGroup = `(?:${dev.protocols}|${dev.prefixes})`;
            } else if (hasProtocol) {
                prefixGroup = `(?:${dev.protocols})`;
            } else {
                prefixGroup = `(?:${dev.prefixes})`;
            }
            patternParts.push(`${prefixGroup}${exclusionSet}+`);
        }

        // 部分 B: 裸域名
        if (!dev.strictHttpMode && dev.allowedTLDs.trim().length > 0) {
            const tlds = dev.allowedTLDs.split('|').map(s => s.trim()).filter(s => s).join('|');
            const suffixBoundary = `(?![a-zA-Z0-9-])`;
            patternParts.push(`[${domainChars}]+\\.(?:${tlds})${suffixBoundary}${exclusionSet}*`);
        }

        // 部分 C: IP 地址
        if (dev.enableIpMatch) {
            const ipPattern = `(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?(?:${exclusionSet}*)?`;
            patternParts.push(ipPattern);
        }

        // 部分 D: Localhost
        if (dev.enableLocalhostMatch) {
            const localhostPattern = `localhost(?::\\d+)?(?:${exclusionSet}*)?`;
            patternParts.push(localhostPattern);
        }

        // 合并
        if (patternParts.length === 0) {
            urlRegex = /(?!)/gi;
        } else {
            urlRegex = new RegExp(`(${patternParts.join('|')})`, 'gi');
        }
    };

    compileRegex();

    // ==========================================
    // 3. 黑白名单检查逻辑
    // ==========================================
    const checkIsEnabled = () => {
        const currentUrl = window.location.href;
        const list = config.urlList || [];
        const isInList = list.some(item => currentUrl.includes(item));
        if (config.listMode === 'whitelist') return isInList;
        return !isInList;
    };

    // ==========================================
    // 4. 样式注入
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

            if (styleConfig.borderEnabled) {
                css += `outline: ${styleConfig.borderWidth}px solid ${styleConfig.borderColor};`;
                css += `outline-offset: ${styleConfig.borderOffset}px;`;
                css += `border-radius: ${styleConfig.borderRadius}px;`;
            } else {
                css += `outline: none;`;
            }

            if (styleConfig.underlineEnabled) css += `text-decoration: underline;`;
            else css += `text-decoration: none;`;

            if (styleConfig.italicEnabled) css += `font-style: italic;`;
            else css += `font-style: normal;`;

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
                ${generateCss(config.styles.hover)}
            }
        `;
        styleEl.textContent = baseCss + hoverCss;
    };

    // ==========================================
    // 5. 标题获取与过滤功能
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

        if (titleCache.size > config.devSettings.titleCacheLimit) {
            const keys = titleCache.keys();
            const limit = Math.floor(config.devSettings.titleCacheLimit / 2);
            for(let i=0; i<limit; i++) titleCache.delete(keys.next().value);
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: config.devSettings.titleFetchTimeout,
            onload: function(response) {
                const titleRegex = parseRegexString(config.devSettings.titleFetchRegex);
                let title = null;

                if (titleRegex) {
                    const matches = response.responseText.match(titleRegex);
                    if (matches && matches[1]) title = matches[1].trim();
                }

                if (!title) {
                    const defRegex = /<title>([^<]*)<\/title>/i;
                    const defMatches = response.responseText.match(defRegex);
                    if (defMatches && defMatches[1]) title = defMatches[1].trim();
                }

                if (title) {
                    titleCache.set(url, title);
                    applyFilteredTitle(title, element);
                } else {
                    titleCache.set(url, null);
                }
            },
            onerror: function() {},
            ontimeout: function() {}
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
    // 6. 核心逻辑：文本节点处理
    // ==========================================
    const stripTrailingPunctuation = (url) => {
        const dev = config.devSettings;
        const trimSet = new Set(dev.trimChars.split(''));

        const pairs = { ')': '(', ']': '[', '}': '{' };
        const checkBalance =
            (trimSet.has(')') || trimSet.has('）')) ||
            (trimSet.has(']') || trimSet.has('】')) ||
            (trimSet.has('}') || trimSet.has('｝'));

        let cleanUrl = url;

        while (cleanUrl.length > 0) {
            const lastChar = cleanUrl[cleanUrl.length - 1];

            if (checkBalance && pairs[lastChar]) {
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

            if (trimSet.has(lastChar)) {
                cleanUrl = cleanUrl.slice(0, -1);
                continue;
            }

            break;
        }
        return cleanUrl;
    };

    const processTextNode = (textNode) => {
        const parentTag = textNode.parentNode.tagName;
        const excludeTags = config.devSettings.excludeTags.toUpperCase().split(',').map(s => s.trim());
        if (excludeTags.includes(parentTag)) return;

        // 新增：检查排除类名
        if (config.devSettings.excludeClassNames && config.devSettings.excludeClassNames.trim().length > 0) {
            const excludeClasses = config.devSettings.excludeClassNames.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            // 检查当前元素及其所有父元素的类名
            let el = textNode.parentNode;
            while (el && el !== document.body) {
                if (el.classList) {
                    for (let cls of excludeClasses) {
                        if (el.classList.contains(cls)) return;
                    }
                }
                el = el.parentNode;
            }
        }

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

            if (cleanUrl.length < config.devSettings.minLinkLength) {
                fragment.appendChild(document.createTextNode(rawUrl));
                lastIndex = index + rawUrl.length;
                return;
            }

            const wrapper = document.createElement('span');
            wrapper.className = 'smart-link-wrapper';

            // 新增：显示长度截断逻辑
            let displayText = cleanUrl;
            const maxLen = config.devSettings.maxDisplayLength;
            if (maxLen > 0 && displayText.length > maxLen) {
                displayText = displayText.substring(0, maxLen) + '...';
                // 添加 title 提示完整链接
                wrapper.title = cleanUrl;
            }

            wrapper.textContent = displayText;

            let href = cleanUrl;
            const hasProto = /^[a-z]+:\/\//i.test(href);
            const isSpecial = /^(?:\d{1,3}\.){3}\d{1,3}/i.test(href) || href.startsWith('localhost');

            if (!hasProto) {
                 href = config.devSettings.defaultProtocol + href;
            }

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
    // 7. 动态监听 (含防抖)
    // ==========================================
    let observer = null;
    let debounceTimer = null;

    const startObserver = () => {
        if(observer) return;
        observer = new MutationObserver((mutations) => {
            const hasStyles = config.styles.default.textColorEnabled || config.styles.default.borderEnabled;
            if (!hasStyles && !config.enableTitleFetch) return;

            // 开发选项：防抖处理
            if (config.devSettings.debounceDelay > 0) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    for (let mutation of mutations) {
                        for (let node of mutation.addedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE) walk(node);
                            else if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
                        }
                    }
                }, config.devSettings.debounceDelay);
            } else {
                // 无防抖，立即执行
                for (let mutation of mutations) {
                    for (let node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) walk(node);
                        else if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    // ==========================================
    // 8. 配置面板 UI
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
            <div style="position: fixed; top: 10px; right: 10px; background: #2b2b2b; border: 1px solid #555; padding: 15px; z-index: 99999; box-shadow: 0 0 15px rgba(0,0,0,0.5); font-family: sans-serif; font-size: 14px; border-radius: 8px; width: 420px; max-height: 90vh; overflow-y: auto; color: #eee;">
                <h3 style="margin: 0 0 10px; font-size: 16px; color: #fff; border-bottom: 1px solid #444; padding-bottom: 8px;">链接增强设置 v3.6</h3>

                <!-- 样式配置区域 -->
                <div style="background: #333; border: 1px solid #444; padding: 8px; border-radius: 4px; margin-bottom: 10px;">
                    <div style="font-weight: bold; margin-bottom: 8px; color: #fff;">🎨 样式配置</div>

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

                <!-- ========================================== -->
                <!-- 开发人员选项区域 -->
                <!-- ========================================== -->
                <div style="margin-top: 15px; border-top: 2px solid #8b0000; padding-top: 10px;">
                    <div style="background: #8b0000; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; text-align: center; font-weight: bold;">
                        ⚠️ 开发人员选项<br>
                        <span style="font-size: 11px; font-weight: normal;">在修改以下配置前你必须知道你自己在做什么!</span>
                    </div>

                    <div style="background: #333; padding: 8px; border-radius: 4px; border: 1px solid #444;">

                        <!-- 标题提取设置 -->
                        <div style="border-bottom: 1px dashed #666; margin-bottom: 8px; padding-bottom: 8px;">
                            <div style="font-weight: bold; color: #ff9999; margin-bottom: 5px;">标题提取设置</div>
                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">获取标题正则 (需含捕获组):</label>
                                <input type="text" id="cfg-title-fetch-regex" value="${config.devSettings.titleFetchRegex}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">用于从HTML源码中提取标题。默认: /&lt;title&gt;([^&lt;]*)&lt;\/title&gt;/i</div>
                            </div>
                        </div>

                        <!-- 正则核心参数 -->
                        <div style="border-bottom: 1px dashed #666; margin-bottom: 8px; padding-bottom: 8px;">
                            <div style="font-weight: bold; color: #ff9999; margin-bottom: 5px;">正则核心构造参数</div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">匹配协议 (正则语法, | 分隔):</label>
                                <input type="text" id="cfg-protocols" value="${config.devSettings.protocols}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">例如: https?:\\/\\/ 或 (http|ftp):\\/\\/</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">匹配前缀 (正则语法, | 分隔):</label>
                                <input type="text" id="cfg-prefixes" value="${config.devSettings.prefixes}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">例如: www\\. 或 (www|m)\\.</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">域名主体字符集:</label>
                                <input type="text" id="cfg-domain-chars" value="${config.devSettings.domainChars}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">定义裸域名点号前允许出现的字符。</div>
                            </div>

                            <div style="margin-bottom: 8px; display: flex; justify-content: space-between;">
                                <label style="color: #ddd;"><input type="checkbox" id="cfg-ip-match" ${config.devSettings.enableIpMatch ? 'checked' : ''}> 匹配 IP 地址</label>
                                <label style="color: #ddd;"><input type="checkbox" id="cfg-localhost-match" ${config.devSettings.enableLocalhostMatch ? 'checked' : ''}> 匹配 localhost</label>
                            </div>
                             <div style="margin-bottom: 8px;">
                                <label style="color: #ddd;"><input type="checkbox" id="cfg-unicode-domain" ${config.devSettings.allowUnicodeDomains ? 'checked' : ''}> 允许 Unicode 域名</label>
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">支持识别中文域名或其他非英文域名。</div>
                            </div>
                        </div>

                        <!-- 通用高级参数 -->
                         <div style="border-bottom: 1px dashed #666; margin-bottom: 8px; padding-bottom: 8px;">
                            <div style="font-weight: bold; color: #ddd; margin-bottom: 5px;">行为与性能</div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">排除的标签列表 (逗号分隔):</label>
                                <input type="text" id="cfg-exclude-tags" value="${config.devSettings.excludeTags}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">这些标签内的文本将永远不会被处理。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">排除的类名 (逗号分隔):</label>
                                <input type="text" id="cfg-exclude-classes" value="${config.devSettings.excludeClassNames}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">如果元素或其父元素包含这些类名，则跳过。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">最小链接长度:</label>
                                <input type="number" id="cfg-min-len" value="${config.devSettings.minLinkLength}" style="width: 60px; background: #444; color: #fff; border: 1px solid #555;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">短于该值的匹配将被忽略，防止误判。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">最大显示长度 (0为不限):</label>
                                <input type="number" id="cfg-max-len" value="${config.devSettings.maxDisplayLength}" style="width: 60px; background: #444; color: #fff; border: 1px solid #555;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">超过此长度将截断显示并添加"..."，防止撑破布局。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">裸域名默认协议:</label>
                                <select id="cfg-protocol" style="background: #444; color: #fff; border: 1px solid #555;">
                                    <option value="http://" ${config.devSettings.defaultProtocol === 'http://' ? 'selected' : ''}>http://</option>
                                    <option value="https://" ${config.devSettings.defaultProtocol === 'https://' ? 'selected' : ''}>https://</option>
                                </select>
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">当识别到 baidu.com 时点击跳转使用的协议。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">标题获取超时:</label>
                                <input type="number" id="cfg-timeout" value="${config.devSettings.titleFetchTimeout}" style="width: 60px; background: #444; color: #fff; border: 1px solid #555;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">超过该时间将放弃获取标题。</div>
                            </div>

                             <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">标题缓存上限:</label>
                                <input type="number" id="cfg-cache" value="${config.devSettings.titleCacheLimit}" style="width: 60px; background: #444; color: #fff; border: 1px solid #555;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">防止内存泄漏，建议保持默认。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">处理防抖延迟:</label>
                                <input type="number" id="cfg-debounce" value="${config.devSettings.debounceDelay}" style="width: 60px; background: #444; color: #fff; border: 1px solid #555;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">针对频繁更新的网页，等待毫秒数后再处理，避免卡顿。</div>
                            </div>
                        </div>

                        <!-- 字符与后缀控制 -->
                        <div style="margin-bottom: 0px;">
                            <div style="font-weight: bold; color: #ddd; margin-bottom: 5px;">字符与后缀控制</div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; font-weight: bold;">
                                    <input type="checkbox" id="cfg-strict-http" ${config.devSettings.strictHttpMode ? 'checked' : ''}>
                                    严格模式 (仅匹配协议/前缀)
                                </label>
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">如果不勾选，将识别 "baidu.com" 等裸域名。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; font-weight: bold;">
                                    <input type="checkbox" id="cfg-exclude-cn-punc" ${config.devSettings.excludeChinesePunctuation ? 'checked' : ''}>
                                    排除中文标点符号
                                </label>
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">防止中文语境下的误匹配。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">匹配网址后缀列表 (| 分隔):</label>
                                <input type="text" id="cfg-tlds" value="${config.devSettings.allowedTLDs}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">仅裸域名模式生效。防止 file.txt 被误判。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">截止匹配符号列表:</label>
                                <input type="text" id="cfg-stop-chars" value="${config.devSettings.stopChars}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">这些符号绝不应出现在链接内部。</div>
                            </div>

                            <div style="margin-bottom: 8px;">
                                <label style="color: #ddd; display: block; margin-bottom: 3px;">结尾清理符号列表:</label>
                                <input type="text" id="cfg-trim-chars" value="${config.devSettings.trimChars}" style="width: 100%; box-sizing: border-box; background: #444; color: #fff; border: 1px solid #555; font-size: 11px;">
                                <div style="font-size: 10px; color: #aaa; margin-top: 2px;">链接末尾如果是这些符号，将被去除。支持括号平衡检测。</div>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- 开发人员选项结束 -->

                <button id="cfg-close" style="margin-top: 10px; padding: 6px 10px; cursor: pointer; width: 100%; background: #555; color: #fff; border: 1px solid #777; font-weight: bold;">关闭面板</button>
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

        // 常规选项绑定
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

        // --- 开发人员选项事件绑定 ---
        const bindDevEvents = () => {
            const simpleInputBinder = (id, key, isNumber = false, reprocess = true) => {
                document.getElementById(id).onchange = (e) => {
                    let val = e.target.value;
                    if (isNumber) {
                        val = parseInt(val, 10);
                        if (isNaN(val)) val = defaultConfig.devSettings[key];
                    }
                    config.devSettings[key] = val;
                    saveConfig();
                    if (reprocess) {
                        compileRegex();
                        processAll();
                    }
                };
            };

            simpleInputBinder('cfg-exclude-tags', 'excludeTags', false, true);
            simpleInputBinder('cfg-exclude-classes', 'excludeClassNames', false, true);
            simpleInputBinder('cfg-min-len', 'minLinkLength', true, true);
            simpleInputBinder('cfg-max-len', 'maxDisplayLength', true, true);
            simpleInputBinder('cfg-protocol', 'defaultProtocol', false, false);
            simpleInputBinder('cfg-timeout', 'titleFetchTimeout', true, false);
            simpleInputBinder('cfg-cache', 'titleCacheLimit', true, false);
            simpleInputBinder('cfg-debounce', 'debounceDelay', true, false);

            simpleInputBinder('cfg-protocols', 'protocols', false, true);
            simpleInputBinder('cfg-prefixes', 'prefixes', false, true);
            simpleInputBinder('cfg-domain-chars', 'domainChars', false, true);
            simpleInputBinder('cfg-title-fetch-regex', 'titleFetchRegex', false, false);

            document.getElementById('cfg-ip-match').onchange = (e) => {
                config.devSettings.enableIpMatch = e.target.checked;
                saveConfig(); compileRegex(); processAll();
            };

            document.getElementById('cfg-localhost-match').onchange = (e) => {
                config.devSettings.enableLocalhostMatch = e.target.checked;
                saveConfig(); compileRegex(); processAll();
            };

            document.getElementById('cfg-unicode-domain').onchange = (e) => {
                config.devSettings.allowUnicodeDomains = e.target.checked;
                saveConfig(); compileRegex(); processAll();
            };

            document.getElementById('cfg-strict-http').onchange = (e) => {
                config.devSettings.strictHttpMode = e.target.checked;
                saveConfig();
                compileRegex();
                processAll();
            };

            document.getElementById('cfg-exclude-cn-punc').onchange = (e) => {
                config.devSettings.excludeChinesePunctuation = e.target.checked;
                saveConfig();
                compileRegex();
                processAll();
            };

            simpleInputBinder('cfg-tlds', 'allowedTLDs', false, true);
            simpleInputBinder('cfg-stop-chars', 'stopChars', false, true);
            simpleInputBinder('cfg-trim-chars', 'trimChars', false, true);
        };
        bindDevEvents();

        document.getElementById('cfg-close').onclick = () => panel.remove();
    };

    GM_registerMenuCommand("⚙️ 链接增强设置", createPanel);

    // ==========================================
    // 9. 初始化
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
