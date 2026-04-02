"use strict";

var obsidian = require("obsidian");

// --- 1. 多语言支持配置 ---
const TRANSLATIONS = {
    en: {
        settingName: "Auto Update Paths",
        settingDesc: "Automatically update paths in lazy-album blocks when files or folders are moved.",
        showCaptionName: "Show Captions",
        showCaptionDesc: "Display the image filename or custom caption below the image(need restart).",
        noticeChecking: "Lazy Album: Checking for path updates...",
        noticeUpdated: "Lazy Album: Updated {count} paths ✅",
        errorPath: "⚠️ Path invalid: ",
        emptyAlbum: "🖼️ Lazy Album: No images found",
        loading: "⌛ Loading or no content to display",
    },
    zh: {
        settingName: "自动更新路径",
        settingDesc: "当移动图片或文件夹时，自动更新所有 lazy-album 代码块中的路径。",
        showCaptionName: "显示标题",
        showCaptionDesc: "鼠标悬停时显示文件名或自定义标题(重启生效）",
        noticeChecking: "Lazy Album: 正在检查路径更新...",
        noticeUpdated: "Lazy Album: 已自动更新 {count} 处路径 ✅",
        errorPath: "⚠️ 路径失效: ",
        emptyAlbum: "🖼️ Lazy Album: 暂无图片",
        loading: "⌛ 正在加载或无内容可显示",
    }
};

// --- 2. 插件设置界面 ---
class LazyAlbumSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        const t = this.plugin.t; 
        containerEl.empty();
        
        // 自动更新路径开关
        new obsidian.Setting(containerEl)
            .setName(t.settingName)
            .setDesc(t.settingDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoUpdatePath)
                .onChange(async (value) => {
                    this.plugin.settings.autoUpdatePath = value;
                    await this.plugin.saveSettings();
                }));

        // 显示标题开关
        new obsidian.Setting(containerEl)
            .setName(t.showCaptionName)
            .setDesc(t.showCaptionDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showCaption)
                .onChange(async (value) => {
                    this.plugin.settings.showCaption = value;
                    await this.plugin.saveSettings();
                }));
    }
}

// --- 3. 插件主类 ---
module.exports = class LazyAlbumPlugin extends obsidian.Plugin {
    async onload() {
        this.t = this.getTranslations();
        
        // 初始化设置，默认开启 showCaption
        this.settings = Object.assign({ 
            autoUpdatePath: true,
            showCaption: true 
        }, await this.loadData());
        this.addSettingTab(new LazyAlbumSettingTab(this.app, this));

        // 核心：注册 lazy-album 代码块处理器
        this.registerMarkdownCodeBlockProcessor("lazy-album", (src, el, ctx) => {
            const handler = new LazyAlbumRenderer(this, src, el, ctx);
            ctx.addChild(handler);
        });

        this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
            if (!this.settings.autoUpdatePath) return;
            await this.handleGlobalPathUpdate(file, oldPath);
        }));
    }

    getTranslations() {
        const lang = window.localStorage.getItem("language") || "en";
        return lang.startsWith("zh") ? TRANSLATIONS.zh : TRANSLATIONS.en;
    }

    async handleGlobalPathUpdate(file, oldPath) {
        const mdFiles = this.app.vault.getMarkdownFiles();
        let updateCount = 0;

        // 只有当文件名或路径真的在库里被引用时才执行 Notice
        for (const mdFile of mdFiles) {
            // 使用 metadataCache 快速预检，避免全量读取内容，极大提升性能
            const cache = this.app.metadataCache.getFileCache(mdFile);
            if (!cache || !cache.sections || !cache.sections.some(s => s.type === "code")) continue;

            await this.app.vault.process(mdFile, (content) => {
                if (!content.includes("lazy-album") || !content.includes(oldPath)) return content;

                const codeBlockRegex = /```lazy-album[\s\S]*?```/g;
                const newContent = content.replace(codeBlockRegex, (block) => {
                    if (block.includes(oldPath)) {
                        // 统计更新次数（虽然是全量替换，但统计精准到匹配次数）
                        const matches = block.split(oldPath).length - 1;
                        updateCount += matches;
                        return block.split(oldPath).join(file.path);
                    }
                    return block;
                });
                return newContent;
            });
        }

        if (updateCount > 0) {
            new obsidian.Notice(this.t.noticeUpdated.replace("{count}", updateCount.toString()));
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
};

// --- 4. 渲染子类 ---
class LazyAlbumRenderer extends obsidian.MarkdownRenderChild {
    constructor(plugin, src, container, ctx) {
        super(container);
        this.plugin = plugin;
        this.src = src;
        this.container = container;
        this.ctx = ctx;
        this.currentPage = 0;
    }

    onload() {
        this.render();
        this.registerEvent(this.plugin.app.vault.on("create", (f) => this.refreshIfNeed(f)));
        this.registerEvent(this.plugin.app.vault.on("delete", (f) => this.refreshIfNeed(f)));
        this.registerEvent(this.plugin.app.vault.on("rename", (f) => this.refreshIfNeed(f)));
    }

    refreshIfNeed(file) {
        if (this.src.includes(file.path) || (file.parent && this.src.includes(file.parent.path))) {
            this.render();
        }
    }

    async render() {
        this.container.empty();
        const t = this.plugin.t; 
        const lines = this.src.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        
        let columns = 3, gap = 5, perpage = 0, itemsData = [], excludeList = [], rawEntries = [], errors = [];
        let currentMode = "path";

        lines.forEach(line => {
            if (line.startsWith("columns:")) {
                columns = parseInt(line.split(":")[1]) || 3;
            } else if (line.startsWith("gap:")) {
                gap = parseInt(line.split(":")[1]) || 10;
            } else if (line.startsWith("perpage:")) {
                perpage = parseInt(line.split(":")[1]) || 0;
            } 
            else if (line.startsWith("exclude:")) {
                currentMode = "exclude";
                const content = line.replace("exclude:", "").trim();
                if (content) excludeList.push(...content.split(",").map(s => s.trim()));
            } else if (line.startsWith("list:")) {
                currentMode = "path";
                const content = line.replace("list:", "").trim();
                if (content) rawEntries.push(content);
            }
            else if (!line.startsWith("#")) {
                if (currentMode === "exclude") {
                    excludeList.push(line);
                } else {
                    rawEntries.push(line);
                }
            }
        });

        for (const entry of rawEntries) {
            const [pathPart, captionPart] = entry.split("|").map(s => s.trim());
            
            if (pathPart.startsWith("http")) {
                itemsData.push({ url: pathPart, caption: captionPart || "" });
                continue;
            }

            const abstractFile = this.plugin.app.vault.getAbstractFileByPath(pathPart) || 
                                 this.plugin.app.metadataCache.getFirstLinkpathDest(pathPart, this.ctx.sourcePath);

            if (!abstractFile) {
                errors.push(`${t.errorPath}${pathPart}`);
                continue; 
            }

            if (abstractFile instanceof obsidian.TFolder) {
                abstractFile.children.forEach(file => {
                    if (file instanceof obsidian.TFile && ["jpg","jpeg","png","webp","gif"].includes(file.extension.toLowerCase())) {
                        if (!excludeList.includes(file.name) && !excludeList.includes(file.path)) {
                            const imgUrl = this.plugin.app.vault.adapter.getResourcePath(file.path);
                            if (imgUrl) {
                                itemsData.push({ url: imgUrl, caption: file.basename });
                            }
                        }
                    }
                });
            } else if (abstractFile instanceof obsidian.TFile) {
                if (["jpg","jpeg","png","webp","gif"].includes(abstractFile.extension.toLowerCase())) {
                    const imgUrl = this.plugin.app.vault.adapter.getResourcePath(abstractFile.path);
                    if (imgUrl) {
                        itemsData.push({ url: imgUrl, caption: captionPart || abstractFile.basename });
                    }
                } else {
                    errors.push(`⚠️ Not an image: ${pathPart}`);
                }
            }
        }

        if (errors.length > 0) {
            const errDiv = this.container.createEl("div", { cls: "lazy-album-debug" });
            errors.forEach(e => {
                const msg = errDiv.createEl("div", { text: e });
                msg.style.cssText = `
                    color: #c92a2a; 
                    background-color: #fff5f5; 
                    border: 1px solid #ffc9c9;
                    font-size: 0.9em; 
                    padding: 8px 12px; 
                    border-radius: 6px; 
                    margin-bottom: 8px;
                    font-weight: 500;
                `;
            });
        }

        let displayItems = itemsData;
        const isPaging = perpage > 0 && itemsData.length > perpage;
        
        if (isPaging) {
            const maxPage = Math.ceil(itemsData.length / perpage);
            if (this.currentPage >= maxPage) this.currentPage = maxPage - 1;
            if (this.currentPage < 0) this.currentPage = 0;

            const navWrapper = this.container.createEl("div", { cls: "lazy-pagination-wrapper" });
            const capsule = navWrapper.createEl("div", { cls: "lazy-capsule-nav" });

            const prevBtn = capsule.createEl("button", { text: "←", cls: "lazy-nav-btn" });
            prevBtn.disabled = this.currentPage === 0;
            prevBtn.onclick = () => { this.currentPage--; this.render(); };

            capsule.createEl("span", { text: `${this.currentPage + 1} / ${maxPage}`, cls: "lazy-nav-info" });

            const nextBtn = capsule.createEl("button", { text: "→", cls: "lazy-nav-btn" });
            nextBtn.disabled = this.currentPage >= maxPage - 1;
            nextBtn.onclick = () => { this.currentPage++; this.render(); };

            const start = this.currentPage * perpage;
            displayItems = itemsData.slice(start, start + perpage);
        }

        if (displayItems.length > 0) {
            const gallery = this.container.createEl("div", { cls: "lazy-album-container" });
            gallery.style.columnCount = columns.toString();
            gallery.style.columnGap = gap + "px";
            
            displayItems.forEach(item => {
                const itemDiv = gallery.createEl("div", { cls: "lazy-album-item" });
                itemDiv.style.marginBottom = gap + "px";
                
                itemDiv.createEl("img", { 
                    cls: "lazy-album-img", 
                    attr: { src: item.url, loading: "lazy" } 
                });

                // 这里根据全局设置 showCaption 决定是否渲染标题
                if (this.plugin.settings.showCaption && item.caption) {
                    itemDiv.createEl("div", { cls: "lazy-album-caption", text: item.caption });
                }
            });
        } else if (errors.length === 0) {
            this.container.createEl("div", { text: t.emptyAlbum, cls: "lazy-album-empty" });
        }
    }
}
