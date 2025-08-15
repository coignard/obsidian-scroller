const { Plugin, MarkdownView, PluginSettingTab, Setting } = require('obsidian');
const { EditorView, ViewPlugin, Decoration } = require('@codemirror/view');
const { RangeSet } = require('@codemirror/state');

const DEFAULT_SETTINGS = {
    enableAutoScroll: true,
    scrollOnModeSwitch: true,
    hideScrollbars: true,

    enableTypewriterMode: true,
    restrictToDailyNotes: false,
    typewriterOffset: 0.5,

    useLineBoundaries: false,
    visibleLineCount: 5,

    enableContentDimming: true,
    focusMode: 'sentence',
    sectionHeaderPattern: '^# ([01]\\d|2[0-3]):[0-5]\\d',
    unfocusedOpacity: 0.25,

    enableSmoothScrolling: true,
    smoothScrollDuration: 250
};

module.exports = class ScrollerPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'scroll-to-bottom',
            name: 'Scroll to bottom',
            callback: () => this.ensureEditModeAndScroll('bottom'),
        });

        this.addCommand({
            id: 'scroll-to-top',
            name: 'Scroll to top',
            callback: () => this.ensureEditModeAndScroll('top'),
        });

        if (this.settings.enableAutoScroll) {
            this.registerEvent(
                this.app.workspace.on('file-open', (file) => {
                    if (!this.isActiveFileDailyNote()) return;
                    this.ensureEditModeAndScroll('bottom');
                })
            );

            this.registerEvent(
                this.app.workspace.on('active-leaf-change', (leaf) => {
                    if (!leaf || !leaf.view || !this.isActiveFileDailyNote()) return;
                    this.ensureEditModeAndScroll('bottom');
                })
            );
        }

        if (this.settings.scrollOnModeSwitch) {
            this.registerEvent(
                this.app.workspace.on('layout-change', () => {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView && activeView.getMode() === 'source') {
                        this.scrollToPosition(activeView.editor, 'bottom');
                    }
                })
            );
        }

        this.registerEditorExtension(this.createEditorExtension());
        this.addSettingTab(new ScrollerSettingTab(this.app, this));
        this.updateDynamicStyles();
    }

    createEditorExtension() {
        const plugin = this;

        return ViewPlugin.fromClass(class {
            constructor(view) {
                this.view = view;
                this.pendingScrollUpdate = false;
                this.decorations = this.buildDecorations(view);
                this.anim = null;
                this.scheduleScrollUpdate();
            }

            update(updateTransaction) {
                const needsDecorationUpdate = updateTransaction.docChanged ||
                                              updateTransaction.selectionSet ||
                                              updateTransaction.viewportChanged;
                const needsScrollUpdate = updateTransaction.docChanged || updateTransaction.selectionSet;

                if (needsDecorationUpdate) {
                    this.decorations = this.buildDecorations(updateTransaction.view);
                }
                if (needsScrollUpdate) {
                    this.scheduleScrollUpdate();
                }
            }

            scheduleScrollUpdate() {
                if (this.pendingScrollUpdate) return;
                this.pendingScrollUpdate = true;
                requestAnimationFrame(() => {
                    this.applyTypewriterScrolling(this.view);
                    this.pendingScrollUpdate = false;
                });
            }

            shouldApplyTypewriterFeatures() {
                if (!plugin.settings.enableTypewriterMode) return false;
                if (plugin.settings.restrictToDailyNotes && !plugin.isActiveFileDailyNote()) {
                    return false;
                }
                return true;
            }

            smoothScrollingEnabled() {
                if (!plugin.settings.enableSmoothScrolling) return false;
                return true;
            }

            stopAnimation() {
                if (this.anim && this.anim.rafId) cancelAnimationFrame(this.anim.rafId);
                this.anim = null;
            }

            animateScrollTo(targetTop) {
                const scrollDOM = this.view.scrollDOM;
                const maxTop = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
                const to = Math.max(0, Math.min(targetTop, maxTop));
                const from = scrollDOM.scrollTop;
                const duration = Math.max(0, Number(plugin.settings.smoothScrollDuration) || 0);

                if (Math.abs(to - from) < 1 || duration === 0) {
                    this.stopAnimation();
                    scrollDOM.scrollTop = to;
                    return;
                }

                this.stopAnimation();
                const start = performance.now();
                const ease = t => 1 - Math.pow(1 - t, 3);

                const step = () => {
                    const now = performance.now();
                    let p = (now - start) / duration;
                    if (p < 0) p = 0;
                    if (p > 1) p = 1;
                    const val = from + (to - from) * ease(p);
                    scrollDOM.scrollTop = val;
                    if (p < 1) {
                        this.anim = { rafId: requestAnimationFrame(step) };
                    } else {
                        this.anim = null;
                    }
                };

                this.anim = { rafId: requestAnimationFrame(step) };
            }

            applyTypewriterScrolling(editorView) {
                if (!this.shouldApplyTypewriterFeatures() || !editorView.state.selection.main.empty) return;

                const { state } = editorView;
                const cursorPosition = state.selection.main.head;
                const editorHeight = editorView.dom.clientHeight;
                const scrollDOM = editorView.scrollDOM;

                if (plugin.settings.useLineBoundaries) {
                    const linesToKeep = plugin.settings.visibleLineCount;
                    const lineHeight = editorView.defaultLineHeight;
                    const cursorCoords = editorView.coordsAtPos(cursorPosition);
                    if (!cursorCoords) return;

                    const topBoundary = linesToKeep * lineHeight;
                    const bottomBoundary = editorHeight - (linesToKeep * lineHeight);

                    const containerRect = scrollDOM.getBoundingClientRect();
                    const currentTop = scrollDOM.scrollTop;
                    const cursorTopInContainer = cursorCoords.top - containerRect.top + currentTop;
                    const cursorBottomInContainer = cursorCoords.bottom - containerRect.top + currentTop;

                    if (cursorTopInContainer < topBoundary) {
                        if (this.smoothScrollingEnabled()) {
                            this.animateScrollTo(cursorTopInContainer - topBoundary);
                        } else {
                            editorView.dispatch({
                               effects: EditorView.scrollIntoView(cursorPosition, { y: 'start', yMargin: topBoundary })
                            });
                        }
                    } else if (cursorBottomInContainer > bottomBoundary) {
                        if (this.smoothScrollingEnabled()) {
                            this.animateScrollTo(cursorBottomInContainer - bottomBoundary);
                        } else {
                            editorView.dispatch({
                               effects: EditorView.scrollIntoView(cursorPosition, { y: 'end', yMargin: editorHeight - bottomBoundary })
                            });
                        }
                    }
                } else {
                    const verticalOffset = editorHeight * plugin.settings.typewriterOffset;
                    const coords = editorView.coordsAtPos(cursorPosition);
                    if (!coords) return;

                    const containerRect = scrollDOM.getBoundingClientRect();
                    const currentTop = scrollDOM.scrollTop;
                    const cursorTopInContainer = coords.top - containerRect.top + currentTop;
                    const targetTop = cursorTopInContainer - verticalOffset;

                    if (this.smoothScrollingEnabled()) {
                        this.animateScrollTo(targetTop);
                    } else {
                        editorView.dispatch({
                            effects: EditorView.scrollIntoView(cursorPosition, {
                                y: "center",
                                yMargin: verticalOffset - (editorHeight / 2)
                            })
                        });
                    }
                }
            }

            findSentenceBoundaries(text, position) {
                const sentenceEndRegex = /[.!?]+[\s]*(?=[A-ZА-Я]|$)/g;
                const boundaries = [];
                let match;

                while ((match = sentenceEndRegex.exec(text)) !== null) {
                    boundaries.push(match.index + match[0].length);
                }

                let sentenceStart = 0;
                for (const boundary of boundaries) {
                    if (position <= boundary) {
                        return { start: sentenceStart, end: boundary };
                    }
                    sentenceStart = boundary;
                }

                return { start: sentenceStart, end: text.length };
            }

            buildDecorations(editorView) {
                if (!this.shouldApplyTypewriterFeatures() || !plugin.settings.enableContentDimming) {
                    return RangeSet.empty;
                }

                if (!editorView.state.selection.main.empty) {
                    return RangeSet.empty;
                }

                const decorationBuilder = [];
                const dimmedDecoration = Decoration.mark({ class: 'scroller-dimmed-content' });
                const { state } = editorView;
                const cursorPosition = state.selection.main.head;

                if (plugin.settings.focusMode === 'sentence') {
                    let headerRegex;
                    try {
                        headerRegex = new RegExp(plugin.settings.sectionHeaderPattern);
                    } catch (error) {
                        return RangeSet.empty;
                    }

                    const cursorLine = state.doc.lineAt(cursorPosition);
                    const paragraphStartLine = this.findParagraphStart(state, cursorLine.number);

                    let sentenceStart = null;
                    let sentenceEnd = null;
                    let includeHeader = false;

                    if (paragraphStartLine && paragraphStartLine.number > 1) {
                        const prevLine = state.doc.line(paragraphStartLine.number - 1);
                        if (headerRegex.test(prevLine.text)) {
                            includeHeader = true;
                        }
                    }

                    if (cursorLine.text.trim().length > 0) {
                        const cursorPositionInLine = cursorPosition - cursorLine.from;
                        const sentence = this.findSentenceBoundaries(cursorLine.text, cursorPositionInLine);
                        sentenceStart = cursorLine.from + sentence.start;
                        sentenceEnd = cursorLine.from + sentence.end;

                        if (includeHeader && sentence.start === 0) {
                            const headerLine = state.doc.line(paragraphStartLine.number - 1);
                            sentenceStart = headerLine.from;
                        }
                    } else {
                        const prevContentLine = this.findPreviousContentLine(state, cursorLine.number);
                        if (prevContentLine) {
                            const sentence = this.findSentenceBoundaries(prevContentLine.text, prevContentLine.text.length);
                            sentenceStart = prevContentLine.from + sentence.start;
                            sentenceEnd = prevContentLine.from + sentence.end;

                            const paragraphStart = this.findParagraphStart(state, prevContentLine.number);
                            if (paragraphStart && paragraphStart.number > 1) {
                                const headerLine = state.doc.line(paragraphStart.number - 1);
                                if (headerRegex.test(headerLine.text) && sentence.start === 0) {
                                    sentenceStart = headerLine.from;
                                }
                            }
                        }
                    }

                    if (sentenceStart !== null && sentenceEnd !== null) {
                        if (sentenceStart > 0) {
                            decorationBuilder.push(dimmedDecoration.range(0, sentenceStart));
                        }
                        if (sentenceEnd < state.doc.length) {
                            decorationBuilder.push(dimmedDecoration.range(sentenceEnd, state.doc.length));
                        }
                    }

                } else if (plugin.settings.focusMode === 'paragraph') {
                    let headerRegex;
                    try {
                        headerRegex = new RegExp(plugin.settings.sectionHeaderPattern);
                    } catch (error) {
                        return RangeSet.empty;
                    }

                    const cursorLine = state.doc.lineAt(cursorPosition);
                    let paragraphStart = null;
                    let paragraphEnd = null;

                    if (cursorLine.text.trim().length > 0) {
                        paragraphStart = cursorLine.from;
                        paragraphEnd = cursorLine.to;

                        for (let lineNum = cursorLine.number - 1; lineNum >= 1; lineNum--) {
                            const line = state.doc.line(lineNum);
                            if (line.text.trim().length === 0) {
                                break;
                            }
                            paragraphStart = line.from;
                        }

                        for (let lineNum = cursorLine.number + 1; lineNum <= state.doc.lines; lineNum++) {
                            const line = state.doc.line(lineNum);
                            if (line.text.trim().length === 0) {
                                break;
                            }
                            paragraphEnd = line.to;
                        }

                        const startLineNum = state.doc.lineAt(paragraphStart).number;
                        if (startLineNum > 1) {
                            const prevLine = state.doc.line(startLineNum - 1);
                            if (headerRegex.test(prevLine.text)) {
                                paragraphStart = prevLine.from;
                            }
                        }

                    } else {
                        for (let lineNum = cursorLine.number - 1; lineNum >= 1; lineNum--) {
                            const line = state.doc.line(lineNum);
                            if (line.text.trim().length > 0) {
                                paragraphEnd = line.to;
                                paragraphStart = line.from;

                                for (let upLineNum = lineNum - 1; upLineNum >= 1; upLineNum--) {
                                    const upLine = state.doc.line(upLineNum);
                                    if (upLine.text.trim().length === 0) {
                                        break;
                                    }
                                    paragraphStart = upLine.from;
                                }

                                const startLineNum = state.doc.lineAt(paragraphStart).number;
                                if (startLineNum > 1) {
                                    const prevLine = state.doc.line(startLineNum - 1);
                                    if (headerRegex.test(prevLine.text)) {
                                        paragraphStart = prevLine.from;
                                    }
                                }

                                break;
                            }
                        }
                    }

                    if (paragraphStart !== null && paragraphEnd !== null) {
                        if (paragraphStart > 0) {
                            decorationBuilder.push(dimmedDecoration.range(0, paragraphStart));
                        }
                        if (paragraphEnd < state.doc.length) {
                            decorationBuilder.push(dimmedDecoration.range(paragraphEnd, state.doc.length));
                        }
                    }

                } else if (plugin.settings.focusMode === 'section') {
                    let headerRegex;
                    try {
                        headerRegex = new RegExp(plugin.settings.sectionHeaderPattern);
                    } catch (error) {
                        return RangeSet.empty;
                    }

                    const headerPositions = [];
                    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
                        const line = state.doc.line(lineNumber);
                        if (headerRegex.test(line.text)) {
                            headerPositions.push(line.from);
                        }
                    }

                    let currentSectionStart = 0;
                    let currentSectionEnd = state.doc.length;

                    const lastHeaderBeforeCursor = headerPositions.filter(pos => pos <= cursorPosition).pop();

                    if (lastHeaderBeforeCursor !== undefined) {
                        currentSectionStart = lastHeaderBeforeCursor;
                        const nextHeaderIndex = headerPositions.findIndex(pos => pos > currentSectionStart);
                        if (nextHeaderIndex !== -1) {
                            currentSectionEnd = headerPositions[nextHeaderIndex];
                        }
                    } else if (headerPositions.length > 0) {
                        currentSectionEnd = headerPositions[0];
                    } else {
                        return RangeSet.empty;
                    }

                    if (currentSectionStart > 0) {
                        decorationBuilder.push(dimmedDecoration.range(0, currentSectionStart));
                    }
                    if (currentSectionEnd < state.doc.length) {
                        decorationBuilder.push(dimmedDecoration.range(currentSectionEnd, state.doc.length));
                    }

                } else {
                    const currentLine = state.doc.lineAt(cursorPosition);
                    if (currentLine.from > 0) {
                        decorationBuilder.push(dimmedDecoration.range(0, currentLine.from));
                    }
                    if (currentLine.to < state.doc.length) {
                        decorationBuilder.push(dimmedDecoration.range(currentLine.to, state.doc.length));
                    }
                }

                try {
                    return Decoration.set(decorationBuilder.sort((a, b) => a.from - b.from));
                } catch (error) {
                    return RangeSet.empty;
                }
            }

            findParagraphStart(state, lineNumber) {
                for (let lineNum = lineNumber; lineNum >= 1; lineNum--) {
                    const line = state.doc.line(lineNum);
                    if (line.text.trim().length > 0) {
                        for (let upLineNum = lineNum - 1; upLineNum >= 1; upLineNum--) {
                            const upLine = state.doc.line(upLineNum);
                            if (upLine.text.trim().length === 0) {
                                return line;
                            }
                        }
                        return state.doc.line(1);
                    }
                }
                return null;
            }

            findPreviousContentLine(state, lineNumber) {
                for (let lineNum = lineNumber - 1; lineNum >= 1; lineNum--) {
                    const line = state.doc.line(lineNum);
                    if (line.text.trim().length > 0) {
                        return line;
                    }
                }
                return null;
            }
        }, {
            decorations: viewInstance => viewInstance.decorations
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateDynamicStyles();
        this.app.workspace.updateOptions();
    }

    scrollPageByDirection(editor, direction) {
        const editorView = editor.cm;
        if (editorView && editorView.scrollDOM) {
            const scrollContainer = editorView.scrollDOM;
            const pageHeight = scrollContainer.clientHeight * 0.8;
            const scrollDistance = direction === 'up' ? -pageHeight : pageHeight;

            if (this.settings.enableSmoothScrolling && this.settings.enableTypewriterMode) {
                const currentTop = scrollContainer.scrollTop;
                const targetTop = currentTop + scrollDistance;
                this.animateScrollTo(scrollContainer, targetTop);
            } else {
                scrollContainer.scrollBy({ top: scrollDistance, behavior: 'smooth' });
            }
        }
    }

    animateScrollTo(scrollContainer, targetTop) {
        const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const to = Math.max(0, Math.min(targetTop, maxTop));
        const from = scrollContainer.scrollTop;
        const duration = Math.max(0, Number(this.settings.smoothScrollDuration) || 0);

        if (Math.abs(to - from) < 1 || duration === 0) {
            scrollContainer.scrollTop = to;
            return;
        }

        const start = performance.now();
        const ease = t => 1 - Math.pow(1 - t, 3);

        const step = () => {
            const now = performance.now();
            let p = (now - start) / duration;
            if (p < 0) p = 0;
            if (p > 1) p = 1;
            const val = from + (to - from) * ease(p);
            scrollContainer.scrollTop = val;
            if (p < 1) {
                requestAnimationFrame(step);
            }
        };

        requestAnimationFrame(step);
    }

    updateDynamicStyles() {
        const dynamicStyleId = 'scroller-styles';
        let styleElement = document.getElementById(dynamicStyleId);
        if (!styleElement) {
            styleElement = document.createElement('style');
            styleElement.id = dynamicStyleId;
            document.head.appendChild(styleElement);
        }

        let cssRules = '';
        if (this.settings.hideScrollbars) {
            cssRules += `
                ::-webkit-scrollbar { display: none !important; }
            `;
        }

        if (this.settings.enableContentDimming) {
            cssRules += `
                .scroller-dimmed-content {
                    opacity: ${this.settings.unfocusedOpacity} !important;
                }
            `;
        }

        styleElement.textContent = cssRules;
    }

    scrollToPosition(editor, position) {
        if (!editor) return;
        const editorView = editor.cm;
        if (!editorView) return;

        if (position === 'top') {
            if (this.settings.enableSmoothScrolling && this.settings.enableTypewriterMode) {
                const scrollContainer = editorView.scrollDOM;
                this.animateScrollTo(scrollContainer, 0);
                editorView.dispatch({
                    selection: { anchor: 0 }
                });
            } else {
                editorView.dispatch({
                    selection: { anchor: 0 },
                    scrollIntoView: true
                });
            }
        } else {
            const documentEnd = editorView.state.doc.length;

            if (this.settings.enableTypewriterMode &&
                (!this.settings.restrictToDailyNotes || this.isActiveFileDailyNote())) {

                editorView.dispatch({
                    selection: { anchor: documentEnd }
                });

                if (this.settings.enableSmoothScrolling) {
                    const scrollContainer = editorView.scrollDOM;
                    const editorHeight = editorView.dom.clientHeight;

                    const endCoords = editorView.coordsAtPos(documentEnd);
                    if (endCoords) {
                        const containerRect = scrollContainer.getBoundingClientRect();
                        const currentTop = scrollContainer.scrollTop;
                        const endPosInContainer = endCoords.top - containerRect.top + currentTop;

                        let targetScroll;
                        if (this.settings.useLineBoundaries) {
                            const linesToKeep = this.settings.visibleLineCount;
                            const lineHeight = editorView.defaultLineHeight;
                            const bottomBoundary = editorHeight - (linesToKeep * lineHeight);
                            targetScroll = endPosInContainer - bottomBoundary;
                        } else {
                            const verticalOffset = editorHeight * this.settings.typewriterOffset;
                            targetScroll = endPosInContainer - verticalOffset;
                        }

                        this.animateScrollTo(scrollContainer, targetScroll);
                    }
                }
            } else {
                if (this.settings.enableSmoothScrolling) {
                    const scrollContainer = editorView.scrollDOM;
                    const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
                    this.animateScrollTo(scrollContainer, maxScroll);
                    editorView.dispatch({
                        selection: { anchor: documentEnd }
                    });
                } else {
                    editorView.dispatch({
                        selection: { anchor: documentEnd },
                        scrollIntoView: true
                    });
                }
            }
        }
    }

    getDailyNoteConfiguration() {
        try {
            return this.app.internalPlugins.plugins['daily-notes']?.instance?.options;
        } catch (error) {
            const vaultConfig = this.app.vault.config;
            return {
                format: vaultConfig?.dailyNoteFormat,
                folder: vaultConfig?.dailyNoteFolder,
                template: vaultConfig?.dailyNoteTemplate
            };
        }
    }

    getCurrentDailyNotePath() {
        const dailyNoteConfig = this.getDailyNoteConfiguration();
        if (!dailyNoteConfig || !dailyNoteConfig.format) return null;

        const todayFilename = window.moment().format(dailyNoteConfig.format);
        const notesFolder = dailyNoteConfig.folder || '';
        return `${notesFolder ? notesFolder + '/' : ''}${todayFilename}.md`.replace(/\/+/g, '/');
    }

    isActiveFileDailyNote() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;

        const expectedDailyNotePath = this.getCurrentDailyNotePath();
        return expectedDailyNotePath &&
               activeFile.path.replace(/^\//, '') === expectedDailyNotePath.replace(/^\//, '');
    }

    async ensureEditModeAndScroll(position) {
        let markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!markdownView) return;

        const viewState = markdownView.getState();
        if (viewState.mode !== 'source' || viewState.source) {
            const newViewState = { ...viewState, mode: 'source', source: false };
            await markdownView.setState(newViewState, { history: false });
        }

        markdownView.editor.focus();
        this.scrollToPosition(markdownView.editor, position);
    }

    onunload() {
        const dynamicStyleElement = document.getElementById('scroller-styles');
        if (dynamicStyleElement) {
            dynamicStyleElement.remove();
        }
    }
}

class ScrollerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Auto-scroll on file open')
            .setDesc('Automatically scroll to bottom when opening daily notes or switching between files.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAutoScroll)
                .onChange(async (value) => {
                    this.plugin.settings.enableAutoScroll = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-scroll on mode change')
            .setDesc('Automatically scroll to bottom when switching from reading to editing mode.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scrollOnModeSwitch)
                .onChange(async (value) => {
                    this.plugin.settings.scrollOnModeSwitch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Hide scrollbars')
            .setDesc('Hide scrollbars throughout the Obsidian interface for a cleaner appearance.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.hideScrollbars)
                .onChange(async (value) => {
                    this.plugin.settings.hideScrollbars = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable typewriter mode')
            .setDesc('Enable advanced editing features including typewriter scrolling, focus dimming, and line boundaries.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTypewriterMode)
                .onChange(async (value) => {
                    this.plugin.settings.enableTypewriterMode = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const typewriterFeaturesContainer = containerEl.createDiv();
        typewriterFeaturesContainer.style.opacity = this.plugin.settings.enableTypewriterMode ? "1" : "0.5";
        typewriterFeaturesContainer.style.pointerEvents = this.plugin.settings.enableTypewriterMode ? "all" : "none";
        typewriterFeaturesContainer.style.borderTop = '1px solid var(--background-modifier-border)';
        typewriterFeaturesContainer.style.paddingTop = '0.75em';

        new Setting(typewriterFeaturesContainer)
            .setName('Restrict to daily notes')
            .setDesc('Only apply typewriter mode features when editing daily notes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.restrictToDailyNotes)
                .onChange(async (value) => {
                    this.plugin.settings.restrictToDailyNotes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Typewriter scrolling')
            .setDesc('Keep the current line at a fixed position while typing.')
            .addToggle(toggle => toggle
                .setValue(!this.plugin.settings.useLineBoundaries)
                .onChange(async (value) => {
                    this.plugin.settings.useLineBoundaries = !value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Typewriter line position')
            .setDesc('Set the vertical position where the active line is maintained.')
            .setDisabled(this.plugin.settings.useLineBoundaries)
            .addSlider(slider => slider
                .setLimits(0, 100, 5)
                .setValue(this.plugin.settings.typewriterOffset * 100)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.typewriterOffset = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Line boundaries')
            .setDesc('Maintain a specified number of visible lines above and below the cursor.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useLineBoundaries)
                .onChange(async (value) => {
                    this.plugin.settings.useLineBoundaries = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Visible line count')
            .setDesc('Number of lines to keep visible above and below the cursor when using line boundaries.')
            .setDisabled(!this.plugin.settings.useLineBoundaries)
            .addText(text => text
                .setValue(String(this.plugin.settings.visibleLineCount))
                .onChange(async (value) => {
                    const parsedValue = parseInt(value, 10);
                    if (!isNaN(parsedValue) && parsedValue >= 0) {
                        this.plugin.settings.visibleLineCount = parsedValue;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Focus mode')
            .setDesc('Dim content outside the current focus area.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableContentDimming)
                .onChange(async (value) => {
                    this.plugin.settings.enableContentDimming = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Focus area')
            .setDesc('Choose whether to focus on the current paragraph, section, sentence or line.')
            .setDisabled(!this.plugin.settings.enableContentDimming)
            .addDropdown(dropdown => dropdown
                .addOption('sentence', 'Sentence')
                .addOption('paragraph', 'Paragraph')
                .addOption('section', 'Section')
                .addOption('line', 'Line')
                .setValue(this.plugin.settings.focusMode)
                .onChange(async (value) => {
                    this.plugin.settings.focusMode = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const sectionPatternSetting = new Setting(typewriterFeaturesContainer)
            .setName('Section header regex')
            .setDesc('Regular expression to identify section headers.')
            .addText(text => text
                .setPlaceholder('^# ([01]\\d|2[0-3]):[0-5]\\d')
                .setValue(this.plugin.settings.sectionHeaderPattern)
                .onChange(async (value) => {
                    this.plugin.settings.sectionHeaderPattern = value;
                    await this.plugin.saveSettings();
                }));
        sectionPatternSetting.settingEl.style.display =
            (this.plugin.settings.enableContentDimming &&
            (this.plugin.settings.focusMode === 'section' || this.plugin.settings.focusMode === 'paragraph' || this.plugin.settings.focusMode === 'sentence')) ? 'flex' : 'none';

        new Setting(typewriterFeaturesContainer)
            .setName('Unfocused content opacity')
            .setDesc('Set the opacity level for dimmed content outside the focus area.')
            .setDisabled(!this.plugin.settings.enableContentDimming)
            .addSlider(slider => slider
                .setLimits(0, 80, 5)
                .setValue(this.plugin.settings.unfocusedOpacity * 100)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.unfocusedOpacity = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Enable smooth scrolling')
            .setDesc('Animate scroll when moving between lines in typewriter mode and using scroll shortcuts.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSmoothScrolling)
                .onChange(async (value) => {
                    this.plugin.settings.enableSmoothScrolling = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(typewriterFeaturesContainer)
            .setName('Smooth scroll duration')
            .setDesc('Set animation duration for smooth scrolling.')
            .setDisabled(!this.plugin.settings.enableSmoothScrolling)
            .addSlider(slider => slider
                .setLimits(50, 1000, 50)
                .setValue(this.plugin.settings.smoothScrollDuration)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.smoothScrollDuration = value;
                    await this.plugin.saveSettings();
                }));
    }
}
