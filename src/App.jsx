import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

const DEFAULT_CFG = {
  base_url: "https://api.openai.com/v1",
  api_key: "",
  model: "gpt-4o-mini",
  direction: "zh->en",
  tts_voice_zh: "",
  tts_voice_en: "",
};

function nowTs() {
  return Date.now();
}

function clampHistory(list) {
  return list.slice(0, 50);
}

function isProbablyUrl(text) {
  return /^https?:\/\//i.test(text.trim());
}

function shouldTranslate(text) {
  const t = text.trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  if (isProbablyUrl(t)) return false;
  if (/^[0-9\s\-_=+*]+$/.test(t)) return false;
  return true;
}

function detectDirection(text) {
  const hasZh = /[\u4e00-\u9fa5]/.test(text);
  const hasEn = /[A-Za-z]/.test(text);
  if (hasZh && !hasEn) return "zh->en";
  if (hasEn && !hasZh) return "en->zh";
  return null;
}

function pickVoice(voices, preferredName, lang) {
  if (!voices || voices.length === 0) return null;
  const exact = voices.filter((v) => (v.lang || "").toLowerCase() === lang.toLowerCase());
  const prefix = voices.filter((v) => (v.lang || "").toLowerCase().startsWith(lang.toLowerCase()));
  const pool = exact.length ? exact : prefix.length ? prefix : voices;
  if (preferredName) {
    const preferred = pool.find((v) => v.name === preferredName) || pool.find((v) => v.name.includes(preferredName));
    if (preferred) return preferred;
  }
  const fallback = pool.find((v) => /Xiaoxiao|Xiaoyi|Yunxi|Microsoft|Google|Natural/i.test(v.name));
  return fallback || pool[0];
}

function normalizeVoiceList(voices) {
  const list = (voices || [])
    .map((v) => ({ name: v.name || "", lang: v.lang || "" }))
    .filter((v) => v.name && v.lang);
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const key = `${v.name}__${v.lang}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export default function App() {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState("translate"); // translate | history | settings
  const [pendingCfg, setPendingCfg] = useState(null); // 未保存的设置
  const [autoClipboard, setAutoClipboard] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [toast, setToast] = useState("");
  const [voiceOptions, setVoiceOptions] = useState([]);

  const toastTimerRef = useRef(null);
  const voiceRef = useRef(null);

  const lastClipboardRef = useRef("");
  const lastAutoSourceRef = useRef("");
  const lastAutoOutputRef = useRef("");

  const dirLabel = useMemo(() => {
    return cfg.direction === "zh->en" ? "中文 → 英文" : "英文 → 中文";
  }, [cfg.direction]);

  useEffect(() => {
    (async () => {
      const data = await invoke("get_config");
      setCfg({ ...DEFAULT_CFG, ...data });
      const list = await invoke("get_history");
      setHistory(clampHistory(list));
    })();
  }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const isEn = cfg.direction === "zh->en";
    const lang = isEn ? "en" : "zh";
    const preferredName = isEn ? cfg.tts_voice_en : cfg.tts_voice_zh;
    const loadVoices = () => {
      const voices = synth.getVoices();
      const list = normalizeVoiceList(voices);
      if (list.length) setVoiceOptions(list);
      if (voices && voices.length) {
        voiceRef.current = pickVoice(voices, preferredName, lang);
      }
    };
    loadVoices();
    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = loadVoices;
    }
    return () => {
      if (synth.onvoiceschanged === loadVoices) {
        synth.onvoiceschanged = null;
      }
    };
  }, [cfg.direction, cfg.tts_voice_en, cfg.tts_voice_zh]);

  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 1800);
    return () => toastTimerRef.current && clearTimeout(toastTimerRef.current);
  }, [toast]);

  function showToast(msg) {
    setToast(msg);
  }

  useEffect(() => {
    let timer;
    if (autoClipboard) {
      timer = setInterval(async () => {
        try {
          const text = await invoke("get_clipboard");
          if (text && text !== lastClipboardRef.current) {
            lastClipboardRef.current = text;

            // stop loop: if clipboard is last auto output, ignore once
            if (text === lastAutoOutputRef.current) {
              lastAutoOutputRef.current = "";
              return;
            }

            if (shouldTranslate(text)) {
              // 防止循环翻译：如果这是上次的自动翻译结果，跳过
              if (text === lastAutoOutputRef.current) {
                return;
              }
              // 防止重复翻译同一内容
              if (text === lastAutoSourceRef.current) return;
              
              const autoDir = detectDirection(text);
              if (autoDir) {
                lastAutoSourceRef.current = text;
                const res = await doTranslate(text, autoDir);
                if (typeof res === "string" && res.trim()) {
                  lastAutoOutputRef.current = res;
                  // 同步更新 lastClipboardRef，避免下次轮询重复检测
                  lastClipboardRef.current = res;
                }
                setInput(text);
                setTab("translate");
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }, 1200);
    }
    return () => timer && clearInterval(timer);
  }, [autoClipboard, cfg]);

  async function copyText(text) {
    if (!text) return;
    try {
      await invoke("set_clipboard", { text });
      showToast("已复制到剪贴板");
    } catch (e) {
      showToast("复制失败");
    }
  }

  function speakText(text) {
    if (!text) return;
    const synth = window.speechSynthesis;
    if (!synth) {
      showToast("当前环境不支持朗读");
      return;
    }
    try {
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      const isEn = cfg.direction === "zh->en";
      utter.lang = isEn ? "en-US" : "zh-CN";
      if (voiceRef.current) {
        utter.voice = voiceRef.current;
      }
      utter.rate = isEn ? 1.05 : 1.0;
      utter.pitch = isEn ? 1.05 : 1.08;
      utter.volume = 1.0;
      synth.speak(utter);
    } catch (e) {
      showToast("朗读失败");
    }
  }
  async function doTranslate(text, dirOverride) {
    const dir = dirOverride || cfg.direction;
    const req = { ...cfg, direction: dir };
    setLoading(true);
    try {
      await invoke("set_config", { cfg: req });
      const res = await invoke("translate", { text });
      setOutput(res);
      const item = { source: text, target: res, ts: nowTs() };
      setHistory((prev) => {
        const next = [item, ...prev];
        return clampHistory(next);
      });
      await invoke("add_history", { item });
      await invoke("set_clipboard", { text: res });
      return res;
    } catch (e) {
      const msg = String(e);
      setOutput(msg);
      return msg;
    } finally {
      setLoading(false);
    }
  }

  function onTranslateClick() {
    const text = input.trim();
    if (!text) return;
    doTranslate(text);
  }

  function onSwapDirection() {
    const next = cfg.direction === "zh->en" ? "en->zh" : "zh->en";
    setCfg({ ...cfg, direction: next });
  }

  async function onSaveSettings() {
    const cfgToSave = pendingCfg || cfg;
    await invoke("set_config", { cfg: cfgToSave });
    setCfg(cfgToSave);
    setPendingCfg(null);
    setTab("translate");
  }

  function onTabChange(newTab) {
    if (newTab !== "settings") {
      setPendingCfg(null);
    }
    setTab(newTab);
  }

  function onSelectVoice(kind, value) {
    const trimmed = value || "";
    const current = pendingCfg || cfg;
    if (kind === "zh") {
      setPendingCfg({ ...current, tts_voice_zh: trimmed });
    } else {
      setPendingCfg({ ...current, tts_voice_en: trimmed });
    }
  }

  async function onClearHistory() {
    await invoke("clear_history");
    setHistory([]);
  }

  async function onTestSettings() {
    setTesting(true);
    setTestResult("");
    try {
      await invoke("set_config", { cfg });
      const sample = cfg.direction === "zh->en" ? "这是测试" : "This is a test";
      const res = await invoke("translate", { text: sample });
      setTestResult(`OK: ${res}`);
    } catch (e) {
      setTestResult(`失败: ${String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="container">
      <header>
        <h1>FlipTrans</h1>
        <nav>
          <button className={tab === "translate" ? "active" : ""} onClick={() => onTabChange("translate")}>
            翻译
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => onTabChange("history")}>
            历史
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => onTabChange("settings")}>
            设置
          </button>
        </nav>
      </header>

      {tab === "translate" && (
        <section className="panel">
          <div className="row">
            <span className="label tag">方向</span>
            <button onClick={onSwapDirection}>{dirLabel}</button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={autoClipboard}
                onChange={(e) => setAutoClipboard(e.target.checked)}
              />
              剪贴板监听
            </label>
          </div>
          <textarea
            placeholder="输入或从剪贴板自动捕获..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="actions">
            <button className="primary" onClick={onTranslateClick} disabled={loading}>
              {loading ? "翻译中..." : "翻译"}
            </button>
          </div>
          <div className="output">
            <div className="label tag">译文</div>
            <div className="output-card">
              <pre>{output}</pre>
              <div className="output-actions">
                <button className="ghost" onClick={() => copyText(output)} disabled={!output}>
                  复制译文
                </button>
                <button className="ghost" onClick={() => speakText(output)} disabled={!output}>
                  朗读
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === "history" && (
        <section className="panel">
          <div className="row">
            <span className="label">最近 50 条</span>
            <button onClick={onClearHistory}>清空</button>
          </div>
          <div className="history">
            {history.length === 0 && <div className="empty">暂无记录</div>}
            {history.map((h, i) => (
              <div className="history-item" key={i}>
                <div className="history-src">{h.source}</div>
                <div className="history-tgt">{h.target}</div>
                <div className="history-ts">{new Date(h.ts).toLocaleString()}</div>
                <div className="history-actions">
                  <button className="ghost" onClick={() => copyText(h.target)}>
                    复制译文
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "settings" && (
        <section className="panel">
          <div className="field">
            <label>Base URL</label>
            <input
              value={(pendingCfg || cfg).base_url}
              onChange={(e) => setPendingCfg({ ...(pendingCfg || cfg), base_url: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div className="field">
            <label>API Key</label>
            <input
              value={(pendingCfg || cfg).api_key}
              onChange={(e) => setPendingCfg({ ...(pendingCfg || cfg), api_key: e.target.value })}
              placeholder="sk-..."
              type="password"
            />
          </div>
          <div className="field">
            <label>Model</label>
            <input
              value={(pendingCfg || cfg).model}
              onChange={(e) => setPendingCfg({ ...(pendingCfg || cfg), model: e.target.value })}
              placeholder="gpt-4o-mini"
            />
          </div>
          <div className="field">
            <label>朗读（中文语音）</label>
            <select value={(pendingCfg || cfg).tts_voice_zh} onChange={(e) => onSelectVoice("zh", e.target.value)}>
              <option value="">自动选择（推荐）</option>
              {voiceOptions
                .filter((v) => v.lang.toLowerCase().startsWith("zh"))
                .map((v) => (
                  <option key={`${v.name}-${v.lang}`} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label>朗读（英文语音）</label>
            <select value={(pendingCfg || cfg).tts_voice_en} onChange={(e) => onSelectVoice("en", e.target.value)}>
              <option value="">自动选择（推荐）</option>
              {voiceOptions
                .filter((v) => v.lang.toLowerCase().startsWith("en"))
                .map((v) => (
                  <option key={`${v.name}-${v.lang}`} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
            </select>
          </div>
          <div className="row">
            <button className="primary" onClick={onSaveSettings}>保存</button>
            <button className="ghost" onClick={onTestSettings} disabled={testing}>
              {testing ? "测试中..." : "测试连接"}
            </button>
          </div>
          {testResult && <div className="test-result">{testResult}</div>}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
