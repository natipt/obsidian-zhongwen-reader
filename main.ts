import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, normalizePath, TFile, requestUrl } from 'obsidian';

const VIEW_TYPE_VOCAB_SIDEBAR = "vocab-sidebar";

// Entries in loaded CEDICT
interface CedictEntry {
	traditional: string;
	simplified: string;
	pinyin: string;
	definitions: string[];
  }

interface ZhongwenReaderPluginSettings {
	saveSentences: boolean;
}

// Entries in user vocab list .json
interface VocabEntry {
	simplified: string;
	traditional: string;
	pinyin: string;
	definitions: string[];
	addedAt: string;
	exampleSentences?: string[]; 
};

const DEFAULT_SETTINGS: ZhongwenReaderPluginSettings = {
	saveSentences: false
}

// derived from https://gist.github.com/ttempe/4010474
const pinyinToBopomofoMasterList: ReadonlyArray<[string, string]> = (() => {
    const initialReplacements: Array<[string, string]> = [
        ["yu", "u:"], ["ü", "u:"], ["v", "u:"],
        ["you", "ㄧㄡ"], ["yi", "i"], ["y", "i"],
        ["wong", "ㄨㄥ"], ["wu", "u"], ["w", "u"]
    ];

    const mainTable: Array<[string, string]> = [
        // Special cases
        ["ju", "ㄐㄩ"], ["qu", "ㄑㄩ"], ["xu", "ㄒㄩ"],
        ["zhi", "ㄓ"], ["chi", "ㄔ"], ["shi", "ㄕ"], ["ri", "ㄖ"],
        ["zi", "ㄗ"], ["ci", "ㄘ"], ["si", "ㄙ"],
        ["r5", "ㄦ"],

        // Initials
        ["b", "ㄅ"], ["p", "ㄆ"], ["m", "ㄇ"], ["f", "ㄈ"],
        ["d", "ㄉ"], ["t", "ㄊ"], ["n", "ㄋ"], ["l", "ㄌ"],
        ["g", "ㄍ"], ["k", "ㄎ"], ["h", "ㄏ"],
        ["j", "ㄐ"], ["q", "ㄑ"], ["x", "ㄒ"],
        ["zh", "ㄓ"], ["ch", "ㄔ"], ["sh", "ㄕ"], ["r", "ㄖ"],
        ["z", "ㄗ"], ["c", "ㄘ"], ["s", "ㄙ"],

        // Finals
        ["a", "ㄚ"], ["o", "ㄛ"], ["e", "ㄜ"], ["ê", "ㄝ"],
        ["i", "ㄧ"], ["u", "ㄨ"], ["u:", "ㄩ"], // u: is for ü

        ["ai", "ㄞ"], ["ei", "ㄟ"], ["ao", "ㄠ"], ["ou", "ㄡ"],
        ["ia", "ㄧㄚ"], ["iao", "ㄧㄠ"], ["ie", "ㄧㄝ"], ["iu", "ㄧㄡ"],
        ["ua", "ㄨㄚ"], ["uai", "ㄨㄞ"], ["ue", "ㄩㄝ"], ["u:e", "ㄩㄝ"],
        ["ui", "ㄨㄟ"], ["uo", "ㄨㄛ"],

        ["an", "ㄢ"], ["en", "ㄣ"], ["in", "ㄧㄣ"], ["un", "ㄨㄣ"], ["u:n", "ㄩㄣ"],
        ["ang", "ㄤ"], ["eng", "ㄥ"], ["ing", "ㄧㄥ"], ["ong", "ㄨㄥ"],
        ["ian", "ㄧㄢ"], ["iang", "ㄧㄤ"], ["iong", "ㄩㄥ"],
        ["uan", "ㄨㄢ"], ["uang", "ㄨㄤ"],

        ["er", "ㄦ"],

        // Tones
        ["1", ""], ["2", "ˊ"], ["3", "ˇ"], ["4", "ˋ"], ["5", "˙"]
    ];

    const combined = [...initialReplacements, ...mainTable];
    combined.sort((a, b) => b[0].length - a[0].length);

    const uniqueMap = new Map<string, string>();
    for (const [key, value] of combined) {
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, value);
        }
    }
    return Array.from(uniqueMap.entries());
})();

function convertSinglePinyinSyllableToBopomofo(pinyinSyllable: string): string {
    if (!pinyinSyllable) return "";
    let result = pinyinSyllable.toLowerCase();

    for (const [pinyinPattern, bopomofoReplacement] of pinyinToBopomofoMasterList) {
        const patternRegex = new RegExp(pinyinPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        result = result.replace(patternRegex, bopomofoReplacement);
    }
    return result;
}

export default class ZhongwenReaderPlugin extends Plugin {
	settings: ZhongwenReaderPluginSettings;
	private cedictMap: Map<string, CedictEntry[]> = new Map();
	private activeHighlight: HTMLElement | null = null;
	private activeWord: string | null = null;
	private activeEntries: CedictEntry[] | null = null;
	private hoverBoxEl: HTMLDivElement | null = null;
	private tooltipEl: HTMLDivElement | null = null;
	public refreshVocabSidebar: (() => void) | null = null;

	// In order to not update vocab list on every keystroke
	private refreshTimer: number | null = null;

	// Save currentMarkdownView so vocab list doesnt disappear when user clicks on vocab sidebar
	public currentMarkdownView: MarkdownView | null = null;

	// For if the user wants to store the current sentence as an example
	private activeExampleSentence: string | null = null;


	private hoverHandler: (e: MouseEvent) => void;	

	async onload() {
		await this.loadSettings();

		// Download dictionary if needed
		const pluginFolder = `${this.app.vault.configDir}/plugins/${this.manifest.id}`; 
		const dictPath = pluginFolder + '/cedict_ts.u8';

		const cedictExists = await this.app.vault.adapter.exists(dictPath);
		if (!cedictExists) {
			new Notice(`Downloading CEDICT...`);

			try {
				const url = 'https://raw.githubusercontent.com/natipt/obsidian-zhongwen-reader/main/cedict_ts.u8';
				const res = await requestUrl({ url });
				await this.app.vault.adapter.writeBinary(dictPath, res.arrayBuffer);
				new Notice(`Download complete!`);
			} catch(err) {
				console.error("Failed to download cedict_ts.u8", err);
				new Notice("Failed to download CEDICT.");
			}
		}

		// Create vocab.json if needed
		const vocabPath = pluginFolder + '/vocab.json';
		const vocabExists = await this.app.vault.adapter.exists(vocabPath);
		if (!vocabExists) {
			try {
				await this.app.vault.adapter.write(vocabPath, '');
			}
			catch(err) {
				console.error("Failed to create vocab.json", err);
			}
		}
		
		// Load dictionary
		const data = await this.loadDictionaryFile(dictPath);
    	this.loadCedictFromText(data);

		this.hoverBoxEl = document.createElement("div");
		this.hoverBoxEl.className = "cedict-hover-box";
		document.body.appendChild(this.hoverBoxEl);

		// Tooltip
		this.tooltipEl = document.createElement("div");
		this.tooltipEl.className = "cedict-tooltip";
		document.body.appendChild(this.tooltipEl);


		// Add settings tab
		this.addSettingTab(new ZhongwenReaderSettingTab(this.app, this));	

		this.hoverHandler = this.hoverHandlerChars.bind(this);
		document.addEventListener("mousemove", this.hoverHandler);

		this.addCommand({
			id: "save-current-hovered-word",
			name: "Save hovered word to vocab list.",
			checkCallback: (checking: boolean) => {
				if (this.activeWord && this.activeEntries) {
					if (!checking) {
						this.addToVocab(this.activeWord, this.activeEntries);
					}
					return true; // show in palette when a word is hovered
				}
				return false; // hide from palette when no word is hovered
			}
		});	

		this.addCommand({
			id: "export-vocab-flashcards",
			name: "Export Vocab to Flashcards",
			callback: () => this.exportVocabToFlashcards()
		});

		this.registerView(
			VIEW_TYPE_VOCAB_SIDEBAR,
			(leaf) => new VocabSidebarView(leaf, this)
		);
		
		this.addRibbonIcon("book-open", "Open Vocab Sidebar", async () => {
			await this.activateView();
		});
		this.app.workspace.onLayoutReady(() => {
			this.activateView();
		});
		// Change vocab sidebar when I change leaf
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				// only change currMDview if new view is also MD, otherwise currentMarkdownView becomes null when i click on sidebar
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					this.currentMarkdownView = view;
					this.triggerSidebarRefresh();
				}
			})
		);
		
		// Change vocab sidebar when user edits leaf
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
				this.refreshTimer = window.setTimeout(() => {
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view) {
						this.currentMarkdownView = view;
						this.triggerSidebarRefresh();
					}
				}, 300); // 300ms delay after last edit
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					this.currentMarkdownView = view;
					this.triggerSidebarRefresh();
				}
			})
		);

		await this.loadHSKVocab();

		this.addCommand({
			id: "highlight-hsk-words",
			name: "Highlight all HSK words in current note..",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor);
				return true;
			  }
			  return false;
			}
		});
		this.addCommand({
			id: "highlight-hsk-1-words",
			name: "Highlight HSK 1 words in current note.",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor, 1);
				return true;
			  }
			  return false;
			}
		});
		this.addCommand({
			id: "highlight-hsk-2-words",
			name: "Highlight HSK 2 words in current note.",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor, 2);
				return true;
			  }
			  return false;
			}
		});
		this.addCommand({
			id: "highlight-hsk-3-words",
			name: "Highlight HSK 3 words in current note.",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor, 3);
				return true;
			  }
			  return false;
			}
		});
		this.addCommand({
			id: "highlight-hsk-4-words",
			name: "Highlight HSK 4 words in current note.",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor, 4);
				return true;
			  }
			  return false;
			}
		});
		this.addCommand({
			id: "highlight-hsk-5-words",
			name: "Highlight HSK 5 words in current note.",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor, 5);
				return true;
			  }
			  return false;
			}
		});
		this.addCommand({
			id: "highlight-hsk-6-words",
			name: "Highlight HSK 6 words in current note.",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.highlightHSKWords(view.editor, 6);
				return true;
			  }
			  return false;
			}
		});
		  
		this.addCommand({
			id: "clear-hsk-highlights",
			name: "Clear HSK Highlights in Current Note",
			checkCallback: (checking) => {
			  const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			  if (view && view.editor) {
				if (!checking) this.clearHSKHighlights(view.editor);
				return true;
			  }
			  return false;
			}
		});		  
	}

	onunload() {
		document.removeEventListener("mousemove", this.hoverHandler);
		if (this.activeHighlight) {
			const parent = this.activeHighlight.parentNode;
			if (parent) {
				parent.replaceChild(
					document.createTextNode(this.activeHighlight.innerText),
					this.activeHighlight
				);
			}
			this.activeHighlight = null;
		}
		if (this.hoverBoxEl) {
			this.hoverBoxEl.remove();
			this.hoverBoxEl = null;
		}
		
		if (this.tooltipEl) {
			this.tooltipEl.style.display = "none"; // just to be safe
			this.tooltipEl.remove();
			this.tooltipEl = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async loadDictionaryFile(fileName: string): Promise<string> {
		const arrayBuffer = await this.app.vault.adapter.readBinary(fileName);
		const decoder = new TextDecoder("utf-8");
		return decoder.decode(arrayBuffer);
	}
	private parseCedictLine(line: string): CedictEntry | null {
		const match = line.match(/^(\S+)\s+(\S+)\s+\[(.+?)\]\s+\/(.+)\//);
		if (!match) return null;
	
		const [, trad, simp, pinyin, defs] = match;
		return {
		  traditional: trad,
		  simplified: simp,
		  pinyin,
		  definitions: defs.split('/')
		};
	  }
	
	private loadCedictFromText(cedictText: string) {
	const lines = cedictText.split('\n');
		for (const line of lines) {
			if (line.startsWith('#') || line.trim() === '') continue;
			const entry = this.parseCedictLine(line);
			if (entry) {
				[entry.traditional, entry.simplified].forEach((form) => {
					if (!this.cedictMap.has(form)) this.cedictMap.set(form, []);
					this.cedictMap.get(form)!.push(entry);
				});
			}
		}
	};

	private hskVocab: Map<number, Set<string>> = new Map();

	async loadHSKVocab() {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/hsk-vocab.json`);
		try {
			const content = await this.app.vault.adapter.read(path);
			const data = JSON.parse(content);

			for (const [level, words] of Object.entries(data)) {
			this.hskVocab.set(Number(level), new Set(words as string[]));
			}
		} catch (err) {
			console.error("Failed to load HSK vocab:", err);
		}
	}

	private highlightHSKWords(editor: Editor, specificLevel?: number) {
		const text = editor.getValue();
	  
		// let modifiedText = rawText;
		let modifiedText: string;
		let alreadyHighlighted = new Set<string>();
		if (specificLevel === undefined) {
			// No specific level: wipe existing highlights
			modifiedText = text.replace(/<span class="hsk-highlight hsk-level-\d+">(.+?)<\/span>/g, '$1');
			// modifiedText = rawText;
			// alreadyHighlighted = new Set<string>();
			this.clearHSKHighlights(editor);
		} else {
			// Specific level: keep existing highlights
			modifiedText = text;
	
			// Fill set with already-highlighted words
			const matches = modifiedText.matchAll(/<span class="hsk-highlight hsk-level-\d+">(.+?)<\/span>/g);
			for (const match of matches) {
				if (match[1]) alreadyHighlighted.add(match[1]);
			}
		}
	  
		// const alreadyHighlighted = new Set<string>();
	  
		// Highlight, but only once, and prefer lower levels
		// const levels = Array.from(this.hskVocab.keys()).sort((a, b) => Number(a) - Number(b));
		const levels = specificLevel 
			? [specificLevel] 
			: Array.from(this.hskVocab.keys()).sort((a, b) => Number(a) - Number(b));
	  
		for (const level of levels) {
		  const words = this.hskVocab.get(level) ?? [];
		  for (const word of words) {
			if (alreadyHighlighted.has(word)) continue;
	  
			const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
			const regex = new RegExp(escapedWord, "g");
	  
			modifiedText = modifiedText.replace(regex, (match) => {
			  alreadyHighlighted.add(match);
			  return `<span class="hsk-highlight hsk-level-${level}">${match}</span>`;
			});
		  }
		}
	  
		editor.setValue(modifiedText);
	}
	
	
	private clearHSKHighlights(editor: Editor) {
		let text = editor.getValue();
		
		// Keep clearing nested spans until there are no more
		let previous;
		do {
			previous = text;
			text = text.replace(/<span class="hsk-highlight hsk-level-\d+">([^<>]*)<\/span>/g, '$1');
		} while (text !== previous);
		
		editor.setValue(text);
	}
	  

	private hoverHandlerChars = (event: MouseEvent) => {
		const el = event.target as HTMLElement;
		const isEditLine = el.closest(".cm-line");
		const isPreviewBlock = el.closest(".markdown-preview-view")?.querySelector(".markdown-preview-sizer");
		const isPreviewTarget = el.closest(".el-p, .el-h1, .el-h2, .el-h3, .el-li, .el-blockquote, .el-table");

		if (!isEditLine && !(isPreviewBlock && isPreviewTarget)) {
			this.hideHoverBox();
			this.hideTooltip();
			return;
		}
			
		const range = document.caretRangeFromPoint(event.clientX, event.clientY);
		if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) {
			this.hideHoverBox();
			this.hideTooltip();
			this.activeHighlight = null;
			this.activeWord = null;
			this.activeEntries = null;
			return;
		}
	
		const textNode = range.startContainer as Text;
		const offset = range.startOffset;
		const text = textNode.textContent ?? "";
	
		// out-of-bounds
		if (offset < 0 || offset >= text.length) {
			this.hideHoverBox();
			return;
		}

		// Only proceed if the hovered character is Chinese
		const chineseChar = /[\u4e00-\u9fff]/;
		if (!chineseChar.test(text[offset])) {
			this.hideHoverBox();
			return;
		}
	
		// Only try to match a word from the hovered char forward
		const match = this.getForwardMatchedWord(text, offset);
		if (!match) {
			this.hideHoverBox();
			return;
		}

		const start = offset;
		const end = Math.min(match.end, textNode.length); // clamps safely

		// Highlight matched word
		const rangeForWord = document.createRange();
		rangeForWord.setStart(textNode, start);
		rangeForWord.setEnd(textNode, end);
	
		const rect = rangeForWord.getBoundingClientRect();
	
		if (this.hoverBoxEl) {
			this.hoverBoxEl.style.left = `${rect.left + window.scrollX}px`;
			this.hoverBoxEl.style.top = `${rect.top + window.scrollY}px`;
			this.hoverBoxEl.style.width = `${rect.width}px`;
			this.hoverBoxEl.style.height = `${rect.height}px`;
			this.hoverBoxEl.style.display = "block";
		}

		if (this.settings.saveSentences) {
			const sentence = this.extractSentenceFromTextAtOffset(text, offset, match.word);
			this.activeExampleSentence = sentence;
		}

		// Tooltip
		this.showTooltipForWord(match.word, rect.left + window.scrollX, rect.top + window.scrollY);
	};
	
	private hideHoverBox() {
		if (this.hoverBoxEl) {
			this.hoverBoxEl.style.display = "none";
		}
	}
	
	private getForwardMatchedWord(text: string, offset: number): { word: string; end: number } | null {
		const maxWordLen = 5;
		const substr = text.slice(offset, offset + maxWordLen);
	
		// Try longest to shortest
		for (let len = maxWordLen; len > 0; len--) {
			const candidate = substr.slice(0, len);
			if (this.cedictMap.has(candidate)) {
				return { word: candidate, end: offset + len };
			}
		}

		return null;
	};	
	  
	
	private showTooltipForWord(word: string, x: number, y: number) {
		if (!this.tooltipEl) return;
	
		const entries = this.cedictMap.get(word);
		if (!entries || entries.length === 0) {
			this.tooltipEl.style.display = "none";
			return;
		}

		// Remove duplicate entries - do I need this? 
		const seen = new Set<string>();
		const uniqueEntries = entries.filter(entry => {
			const id = `${entry.traditional}-${entry.simplified}-${entry.pinyin}-${entry.definitions.join(",")}`;
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});

		this.activeWord = word;
		this.activeEntries = uniqueEntries;

		const text = uniqueEntries.map(entry => {
			const pinyinInfo = this.processPinyin(entry.pinyin);
			return `${entry.simplified} ${entry.simplified !== entry.traditional ? entry.traditional : ""} (${pinyinInfo.accentedPinyin} / ${pinyinInfo.bopomofo})\n${entry.definitions.join('; ')}`;
		}).join('\n\n');

		this.tooltipEl.innerText = text;
		if (!this.hoverBoxEl) return; // Feel like I dont need this? 
		const hoverRect = this.hoverBoxEl.getBoundingClientRect();
		this.tooltipEl.style.left = `${hoverRect.left + window.scrollX}px`;
		this.tooltipEl.style.top = `${hoverRect.bottom + window.scrollY + 4}px`; // 4px padding

		this.tooltipEl.style.display = "block";
	}

	public processPinyin(pinyin: string): { accentedPinyin: string; bopomofo: string } {
		const toneMap: Record<string, string[]> = {
			"a": ["ā", "á", "ǎ", "à", "a"],
			"e": ["ē", "é", "ě", "è", "e"],
			"i": ["ī", "í", "ǐ", "ì", "i"],
			"o": ["ō", "ó", "ǒ", "ò", "o"],
			"u": ["ū", "ú", "ǔ", "ù", "u"],
			"ü": ["ǖ", "ǘ", "ǚ", "ǜ", "ü"]
		};
		const vowels = ["a", "o", "e", "i", "u", "ü"];

		const syllables = pinyin.split(" ");
		const accentedPinyinSyllables: string[] = [];
		const bopomofoResultSyllables: string[] = [];

		for (const pinyinSyllableWithTone of syllables) {
			if (!pinyinSyllableWithTone) {
				accentedPinyinSyllables.push("");
				bopomofoResultSyllables.push("");
				continue;
			}

			bopomofoResultSyllables.push(convertSinglePinyinSyllableToBopomofo(pinyinSyllableWithTone));

			let toneNumber = 0;
			const lastChar = pinyinSyllableWithTone[pinyinSyllableWithTone.length - 1];
			if (lastChar >= '1' && lastChar <= '5') {
				toneNumber = parseInt(lastChar);
			}

			let corePinyin = toneNumber ? pinyinSyllableWithTone.slice(0, -1) : pinyinSyllableWithTone;
			
			let corePinyinForAccenting = corePinyin.replace(/u:/g, "ü");
			let syllableToReturnForAccent = corePinyinForAccenting;

			if (toneNumber >= 1 && toneNumber <= 5) {
				let vowelToReplaceOriginalLogic = "";
				for (const v of vowels) {
					if (corePinyinForAccenting.includes(v)) {
						vowelToReplaceOriginalLogic = v;
						break;
					}
				}

				if (vowelToReplaceOriginalLogic && toneMap[vowelToReplaceOriginalLogic]) {
					const accentedVowel = toneMap[vowelToReplaceOriginalLogic][toneNumber - 1];
					try {
						const regex = new RegExp(vowelToReplaceOriginalLogic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "(?!.*" + vowelToReplaceOriginalLogic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ")", "g");
						syllableToReturnForAccent = corePinyinForAccenting.replace(regex, accentedVowel);
					} catch (e) {
						console.error("Regex error in processPinyin", e);
					}
				}
			}
			accentedPinyinSyllables.push(syllableToReturnForAccent);
		}

		return {
			accentedPinyin: accentedPinyinSyllables.join(" "),
			bopomofo: bopomofoResultSyllables.join(" ")
		};
	}
	
	private hideTooltip() {
		if (this.tooltipEl) {
			this.tooltipEl.style.display = "none";
		}
	}
	private async addToVocab(word: string, entries: CedictEntry[]) {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/vocab.json`);
	
		let list: VocabEntry[] = [];
	
		try {
			const file = await this.app.vault.adapter.read(path);
			list = JSON.parse(file);
		} catch {
			list = [];
		}
	
		const newSentence = (this.activeExampleSentence?.trim() === word ? "" : this.activeExampleSentence?.trim()) || "";
		// I'm supposed to have a check earlier that turns "word" into "" but for some reason not working so I have ^
		// Do i need the "" fallback?
		const existingEntry = list.find(e => e.simplified === word);
		if (existingEntry) {
			// If sentence saving is on and we have a sentence...
			if (this.settings.saveSentences && newSentence) {
				if (!existingEntry.exampleSentences) existingEntry.exampleSentences = [];
				
				// Avoid duplicates
				if (!existingEntry.exampleSentences.includes(newSentence)) {
					existingEntry.exampleSentences.push(newSentence);
					await this.app.vault.adapter.write(path, JSON.stringify(list, null, 2));
					new Notice(`Added new sentence to ${word}.`);
				} else {
					new Notice(`${word} is already in your vocab list.`);
				}
			} else {
				new Notice(`${word} is already in your vocab list.`);
			}
	
			this.activeExampleSentence = null;
			this.refreshVocabSidebar?.();
			return;
		}

		// Merge definitions and choose a rep simplified/traditional
		const allDefs = entries.flatMap(e => e.definitions);
		const uniqueDefs = Array.from(new Set(allDefs)); // remove duplicates
	
		const rep = entries[0]; // representative entry (usually fine but the pinyin can change so i should handle that in the future)
	
		const newEntry: VocabEntry = {
			simplified: rep.simplified,
			traditional: rep.traditional,
			pinyin: rep.pinyin, 
			definitions: uniqueDefs,
			addedAt: new Date().toISOString(),
			...(this.settings.saveSentences && this.activeExampleSentence
				? { exampleSentences: [this.activeExampleSentence] }
				: {})
		};
	
		list.push(newEntry);
	
		await this.app.vault.adapter.write(path, JSON.stringify(list, null, 2));
		new Notice(`Added ${word} to vocab list!`);

		this.refreshVocabSidebar?.();
		this.activeExampleSentence = null;
	}

	private async exportVocabToFlashcards() {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/vocab.json`);
		const outputPath = `Obsidian-Zhongwen-Reader-Vocab-Deck.md`; 
	
		let list: {
			simplified: string;
			traditional: string;
			definitions: string[];
			addedAt: string;
		}[] = [];
	
		try {
			const file = await this.app.vault.adapter.read(path);
			list = JSON.parse(file);
		} catch (e) {
			new Notice("No vocab list found.");
			return;
		}
	
		const lines: string[] = list.map(entry => {
			const defs = entry.definitions.join("; ");
			return `${entry.simplified}::${defs}`;
		});
	
		const content = `#ChineseVocab\n\n${lines.join("\n\n")}`;
	
		await this.app.vault.adapter.write(outputPath, content);
	
		new Notice("Exported vocab to flashcard deck!");
	}	

	private extractSentenceFromTextAtOffset(text: string, offset: number, word: string): string {
		if (!this.settings.saveSentences) return "";
		// Find punctuation boundaries around the word
		const punctuation = /[。！？!?]/;
	
		let start = offset;
		while (start > 0 && !punctuation.test(text[start - 1])) {
			start--;
		}
	
		let end = offset;
		while (end < text.length && !punctuation.test(text[end])) {
			end++;
		}
		if (end < text.length) end++; // include punctuation
	
		const sentence = text.slice(start, end).trim();
	
		// fallback to entire line if sentence is empty or doesn’t contain the word
		if (!sentence || !sentence.includes(word)) {
			const line = text.split('\n').find(l => l.includes(word)) ?? text;
			if (line.trim() === word) return ""; // don't save lonely word lines
			return line.trim();
		}
	
		return sentence;
	}	

	async activateView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VOCAB_SIDEBAR);
		if (leaves.length === 0) {
			await this.app.workspace.getRightLeaf(false).setViewState({
				type: VIEW_TYPE_VOCAB_SIDEBAR,
				active: true
			});
		}
		this.app.workspace.revealLeaf(
			this.app.workspace.getLeavesOfType(VIEW_TYPE_VOCAB_SIDEBAR)[0]
		);
	}

	// needs to be accessed by VocabSidebarView
	public async loadVocabList(): Promise<VocabEntry[]> {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/vocab.json`);
		try {
			const file = await this.app.vault.adapter.read(path);
			return JSON.parse(file);
		} catch {
			return [];
		}
	}

	// Refresh timer so sidebar doesnt get double rendered when I switch leaves
	public triggerSidebarRefresh() {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
	
		this.refreshTimer = window.setTimeout(async () => {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VOCAB_SIDEBAR);
			for (const leaf of leaves) {
				const view = leaf.view;
				if (view instanceof VocabSidebarView) {
					await view.renderSidebar();
				}
			}
		}, 100);
	}
	
	
	public scrollToWordInActiveFile(word: string) {
		const view = this.currentMarkdownView;
		const mode = view?.getMode?.() ?? "source"; // fallback to "source" if undefined

		if (!view) {
			console.warn("No active Markdown view");
			return;
		}
	
		let scroller: HTMLElement | null;

		if (mode === "source") {
			scroller = view.containerEl.querySelector(".cm-scroller");
		} else {
			scroller = view.containerEl.querySelector(".markdown-preview-sizer");
		}

		if (!scroller) return;
	
		let lines: NodeListOf<HTMLElement>;
		if (mode === "source") {
			lines = scroller.querySelectorAll(".cm-line");
		} else {
			lines = scroller.querySelectorAll(
				".el-p, .el-h1, .el-h2, .el-h3, .el-li, .el-blockquote, .el-table"
			);
		}
		
		for (const line of Array.from(lines)) {
			if (line.textContent?.includes(word)) {
				(line as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
	
				// Highlight the line briefly, delayed by 100 to allow DOM to scroll first
				setTimeout(() => {
					line.classList.add("cedict-line-hover");
				
					setTimeout(() => {
						line.classList.remove("cedict-line-hover");
					}, 1500);
				}, 100);
	
				// Restore focus
				// setTimeout(() => view.editor?.focus(), 100);
	
				break;
			}
		}
	}
}

class VocabSidebarView extends ItemView {
	plugin: ZhongwenReaderPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: ZhongwenReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_VOCAB_SIDEBAR;
	}

	getDisplayText() {
		return "Vocabulary";
	}

	getIcon(): string {
		return "book-open"; 
	}

	async onOpen() {
		// const container = this.containerEl;
		// const content = container.querySelector(".view-content") ?? container.children[1];
		// content.empty();
		const container = this.containerEl;
		container.querySelectorAll(".vocab-entry").forEach(el => el.remove());

	
		// Register the refresh callback
		this.plugin.refreshVocabSidebar = () => this.renderSidebar();
	
		await this.waitForView();
		await this.renderSidebar();	
	}
	async onClose() {
		this.plugin.refreshVocabSidebar = null;
	}
	async waitForView() {
		let retries = 10;
		while (!this.plugin.currentMarkdownView && retries-- > 0) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	
	async renderSidebar() {
		const container = this.containerEl.children[1];
		container.empty();
	
		const vocabList = await this.plugin.loadVocabList();

		const view = this.plugin.currentMarkdownView;
		const currentFileText = view?.editor
			? view.editor.getValue()
			: view?.contentEl.textContent ?? "";

		const matchingVocab = vocabList.filter(entry =>
			currentFileText.includes(entry.simplified) || currentFileText.includes(entry.traditional)
		);

		container.createEl("h3", {
			text: "Vocab in this note",
			cls: "vocab-heading"
		});
		// this.containerEl.createEl("h3", {
		// 	text: "Vocab in this note",
		// 	cls: "vocab-heading"
		// });

		if (!matchingVocab.length) {
			container.createEl("p", { text: "No vocab yet." });
			return;
		}
	
		for (const entry of matchingVocab) {
			const wrapper = container.createEl("div", { cls: "vocab-entry" });
	
			// Title: simplified + traditional
			wrapper.createEl("div", {
				text: `${entry.simplified} ${entry.simplified !== entry.traditional ? "(" + entry.traditional + ")": ""}`,
				cls: 'vocab-word'
			});
	
			// Pinyin and Bopomofo
			const pinyinInfo = this.plugin.processPinyin?.(entry.pinyin ?? "");
			const pinyinDisplay = pinyinInfo
				? `${pinyinInfo.accentedPinyin} / ${pinyinInfo.bopomofo}`
				: (entry.pinyin ?? "");
			wrapper.createEl("div", {
				text: pinyinDisplay,
				cls: 'vocab-pinyin'
			});
	
			// Definitions
			wrapper.createEl("div", {
				text: entry.definitions.join(";\n "),
				cls: 'vocab-defs'
			});
	
			// Divider
			// wrapper.createEl("hr");

			// Make wrapper clickable
			wrapper.onclick = () => {
				this.plugin.scrollToWordInActiveFile(entry.simplified);
			};
		}
	}	
}

class ZhongwenReaderSettingTab extends PluginSettingTab {
	plugin: ZhongwenReaderPlugin;

	constructor(app: App, plugin: ZhongwenReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Save example sentences")
			.setDesc("When saving a vocab word, also store the sentence it appears in.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.saveSentences)
				.onChange(async (value) => {
					this.plugin.settings.saveSentences = value;
					await this.plugin.saveSettings();
		}));
	}
}
