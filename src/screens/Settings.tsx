/**
 * Screen — Settings.
 *
 * Provides:
 *   1. API key management — password inputs for all 5 providers, with
 *      Test / Save buttons and live status indicators.
 *   2. Default model selection — per-role dropdowns (MR / TMR) stored in
 *      localStorage.
 *   3. Project folder — display + change the AgCensus base directory.
 *
 * API keys are stored via the Tauri `save_api_key` / `get_api_key` commands
 * (backed by tauri-plugin-store, written to <AppData>/api_keys.json).
 *
 * Session 18: Initial implementation.
 */

import { useState, useEffect, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MODELS_BY_TIER, DEFAULT_MR_MODEL, DEFAULT_TMR_MODEL } from "../providers/model-registry";
import type { Provider, Model } from "../providers/types";
import type { ToastMessage } from "../types/ui";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SettingsProps {
  onBack: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

interface ProviderConfig {
  id: Provider;
  displayName: string;
  envVar: string;
  docsUrl: string;
  accentColor: string; // Tailwind classes for badge
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    docsUrl: "https://platform.deepseek.com/api_keys",
    accentColor: "bg-blue-50 border-blue-200 text-blue-700",
  },
  {
    id: "kimi",
    displayName: "Moonshot / Kimi API key",
    envVar: "MOONSHOT_API_KEY or KIMI_API_KEY",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
    accentColor: "bg-purple-50 border-purple-200 text-purple-700",
  },
  {
    id: "google",
    displayName: "Google Gemini",
    envVar: "GOOGLE_API_KEY",
    docsUrl: "https://aistudio.google.com/apikey",
    accentColor: "bg-red-50 border-red-200 text-red-700",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    envVar: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
    accentColor: "bg-emerald-50 border-emerald-200 text-emerald-700",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
    accentColor: "bg-orange-50 border-orange-200 text-orange-700",
  },
];

// ---------------------------------------------------------------------------
// Tier labels for model dropdowns
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Tier 1 — Budget",
  2: "Tier 2 — Mid-range",
  3: "Tier 3 — Premium",
};

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

const LS_MR_MODEL  = "agcensus_mr_model";
const LS_TMR_MODEL = "agcensus_tmr_model";
const LS_BASE_DIR  = "agcensus_base_dir";

// ---------------------------------------------------------------------------
// Azure connection status type
// ---------------------------------------------------------------------------

type AzureStatus =
  | { ok: true; ms: number }
  | { ok: false; msg: string };

// ---------------------------------------------------------------------------
// Connection status type
// ---------------------------------------------------------------------------

type ConnStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "error"; msg: string };

// ---------------------------------------------------------------------------
// API key row component
// ---------------------------------------------------------------------------

function ApiKeyRow({ config }: { config: ProviderConfig }) {
  const [inputKey, setInputKey]     = useState("");
  const [revealed, setRevealed]     = useState(false);
  const [saved, setSaved]           = useState(false);
  const [saving, setSaving]         = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>({ kind: "idle" });

  // Load saved key on mount (we only get a masked indicator, not the value itself)
  useEffect(() => {
    void invoke<string | null>("get_api_key", { provider: config.id }).then((key) => {
      if (key) {
        setSaved(true);
        // Don't populate the input — force user to type a new key to change
      }
    });
  }, [config.id]);

  async function handleSave() {
    if (!inputKey.trim()) return;
    setSaving(true);
    try {
      await invoke("save_api_key", { provider: config.id, key: inputKey.trim() });
      setSaved(true);
      setInputKey("");
      setConnStatus({ kind: "idle" });
    } catch (err) {
      // onToast not available here — bubble via status
      setConnStatus({ kind: "error", msg: String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    const keyToTest = inputKey.trim() || null;
    if (!keyToTest && !saved) {
      setConnStatus({ kind: "error", msg: "Enter an API key first" });
      return;
    }

    setConnStatus({ kind: "testing" });

    // Route the test through the Node.js sidecar to avoid browser CORS
    // restrictions that block direct calls to provider APIs from the webview.
    try {
      let apiKey: string;
      if (keyToTest) {
        apiKey = keyToTest;
      } else {
        // Test the stored key — retrieve it first
        const storedKey = await invoke<string | null>("get_api_key", { provider: config.id });
        if (!storedKey) {
          setConnStatus({ kind: "error", msg: "No key stored" });
          return;
        }
        apiKey = storedKey;
      }
      const latencyStr = await invoke<string>("test_api_connection_cmd", {
        provider: config.id,
        apiKey,
      });
      setConnStatus({ kind: "ok", latencyMs: parseInt(latencyStr, 10) });
    } catch (err) {
      setConnStatus({ kind: "error", msg: String(err) });
    }
  }

  function statusBadge() {
    switch (connStatus.kind) {
      case "idle":
        return saved ? (
          <span className="text-[11px] text-emerald-600 font-medium">Saved ✓</span>
        ) : (
          <span className="text-[11px] text-gray-400">Not configured</span>
        );
      case "testing":
        return (
          <span className="text-[11px] text-blue-500 flex items-center gap-1">
            <span className="w-2.5 h-2.5 border border-blue-400 border-t-transparent rounded-full animate-spin inline-block" />
            Testing…
          </span>
        );
      case "ok":
        return (
          <span className="text-[11px] text-emerald-600 font-medium">
            ✓ OK · {connStatus.latencyMs} ms
          </span>
        );
      case "error":
        return (
          <span className="text-[11px] text-red-500" title={connStatus.msg}>
            ✗ {connStatus.msg.slice(0, 60)}{connStatus.msg.length > 60 ? "…" : ""}
          </span>
        );
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
      {/* Provider header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-medium border px-1.5 py-0.5 rounded ${config.accentColor}`}
          >
            {config.id.toUpperCase()}
          </span>
          <span className="text-sm font-medium text-gray-800">
            {config.displayName}
          </span>
        </div>
        <div className="flex items-center gap-2">{statusBadge()}</div>
      </div>

      {/* Key input row */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type={revealed ? "text" : "password"}
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            placeholder={saved ? "••••••• (key already saved)" : `Paste ${config.envVar}…`}
            className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-gray-400 pr-8"
          />
          <button
            onClick={() => setRevealed((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 text-[11px]"
            tabIndex={-1}
          >
            {revealed ? "hide" : "show"}
          </button>
        </div>
        <button
          onClick={() => void handleTest()}
          disabled={connStatus.kind === "testing"}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-colors disabled:opacity-50"
        >
          Test
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !inputKey.trim()}
          className="text-xs bg-[#1B4F23] text-white rounded-lg px-3 py-2 hover:bg-[#163d1c] transition-colors disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* Help text */}
      <p className="text-[10px] text-gray-400">
        Key is stored in the local app store. To use environment variable
        instead, set <code className="font-mono">{config.envVar}</code> in{" "}
        <code className="font-mono">.env</code>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model dropdown
// ---------------------------------------------------------------------------

function ModelDropdown({
  label,
  storageKey,
  defaultModel,
}: {
  label: string;
  storageKey: string;
  defaultModel: Model;
}) {
  const [selected, setSelected] = useState<Model>(
    () => (localStorage.getItem(storageKey) as Model | null) ?? defaultModel,
  );

  function handleChange(model: Model) {
    setSelected(model);
    localStorage.setItem(storageKey, model);
  }

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-gray-700">{label}</span>
      <select
        value={selected}
        onChange={(e) => handleChange(e.target.value as Model)}
        className="text-xs border border-gray-200 rounded-lg px-2 py-2 text-gray-700 focus:outline-none focus:border-gray-400 bg-white"
      >
        {([1, 2, 3] as const).map((tier) => (
          <optgroup key={tier} label={TIER_LABELS[tier]}>
            {MODELS_BY_TIER[tier].map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName} (${m.inputCostPerM}/${m.outputCostPerM} per M)
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const Settings: FC<SettingsProps> = ({ onBack, onToast }) => {
  const [baseDir, setBaseDirLocal] = useState<string>(
    () => localStorage.getItem(LS_BASE_DIR) ?? "",
  );
  const [editingDir, setEditingDir] = useState(false);
  const [dirInput, setDirInput]     = useState("");

  // ── Azure OpenAI state ────────────────────────────────────────────────────
  const [azureEndpoint,   setAzureEndpoint]   = useState("");
  const [azureDeployment, setAzureDeployment] = useState("");
  const [azureKey,        setAzureKey]        = useState("");
  const [azureKeyVisible, setAzureKeyVisible] = useState(false);
  const [azureTesting,    setAzureTesting]    = useState(false);
  const [azureStatus,     setAzureStatus]     = useState<AzureStatus | null>(null);
  const [azureConfigured, setAzureConfigured] = useState(false);

  // Load saved Azure settings on mount
  useEffect(() => {
    void Promise.all([
      invoke<string | null>("get_api_key", { provider: "azure_endpoint" }),
      invoke<string | null>("get_api_key", { provider: "azure_deployment" }),
      invoke<string | null>("get_api_key", { provider: "azure_api_key" }),
    ]).then(([ep, dep, key]) => {
      if (ep)  setAzureEndpoint(ep);
      if (dep) setAzureDeployment(dep);
      if (key) { setAzureKey(key); setAzureConfigured(true); }
    });
  }, []);

  async function handleAzureSave() {
    try {
      await invoke("save_api_key", { provider: "azure_endpoint",   key: azureEndpoint });
      await invoke("save_api_key", { provider: "azure_deployment", key: azureDeployment });
      await invoke("save_api_key", { provider: "azure_api_key",    key: azureKey });
      setAzureConfigured(true);
      onToast("Azure OpenAI settings saved.", "success");
    } catch (err) {
      onToast(`Failed to save Azure settings: ${String(err)}`, "error");
    }
  }

  async function handleAzureTest() {
    if (!azureKey || !azureEndpoint || !azureDeployment) {
      setAzureStatus({ ok: false, msg: "Fill in endpoint, deployment, and API key first" });
      return;
    }
    setAzureTesting(true);
    setAzureStatus(null);
    try {
      const bundle = JSON.stringify({
        key: azureKey,
        endpoint: azureEndpoint,
        deployment: azureDeployment,
      });
      const latencyStr = await invoke<string>("test_api_connection_cmd", {
        provider: "azure",
        apiKey: bundle,
      });
      setAzureStatus({ ok: true, ms: parseInt(latencyStr, 10) });
    } catch (err) {
      setAzureStatus({ ok: false, msg: String(err) });
    } finally {
      setAzureTesting(false);
    }
  }

  function handleChangeDir() {
    setDirInput(baseDir);
    setEditingDir(true);
  }

  function handleSaveDir() {
    const trimmed = dirInput.trim();
    if (!trimmed) return;
    localStorage.setItem(LS_BASE_DIR, trimmed);
    setBaseDirLocal(trimmed);
    setEditingDir(false);
    onToast("Project folder updated — reload the project list to see changes.", "info");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#1B4F23] text-white px-6 py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-3xl mx-auto flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-green-200 hover:text-white transition-colors text-sm flex items-center gap-1 shrink-0"
          >
            ← Back
          </button>
          <div>
            <div className="text-sm font-semibold">Settings</div>
            <div className="text-[10px] text-green-200">
              API keys · Models · Project folder
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        {/* ── API Keys ────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            API Keys
          </h2>
          <p className="text-xs text-gray-400 mb-4">
            Keys are saved to the app-local store (never written to your project
            files or source control).  You can also set them as environment
            variables in a <code className="font-mono">.env</code> file at the
            project root — env vars take precedence in development.
          </p>
          <div className="space-y-3">
            {PROVIDERS.map((p) => (
              <ApiKeyRow key={p.id} config={p} />
            ))}

            {/* Azure OpenAI — FAO Microsoft 365 */}
            <div className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                    AZURE
                  </span>
                  <span className="font-semibold text-sm">
                    Azure OpenAI (FAO Microsoft 365)
                  </span>
                </div>
                <span
                  className={
                    azureConfigured ? "text-green-600 text-sm" : "text-gray-400 text-sm"
                  }
                >
                  {azureConfigured ? "✓ Configured" : "Not configured"}
                </span>
              </div>

              <div className="space-y-2 mb-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">
                    Endpoint URL
                  </label>
                  <input
                    type="text"
                    placeholder="https://your-resource.openai.azure.com"
                    value={azureEndpoint}
                    onChange={(e) => setAzureEndpoint(e.target.value)}
                    className="w-full border rounded px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">
                    Deployment name
                  </label>
                  <input
                    type="text"
                    placeholder="gpt-4o"
                    value={azureDeployment}
                    onChange={(e) => setAzureDeployment(e.target.value)}
                    className="w-full border rounded px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">
                    API key
                  </label>
                  <div className="flex gap-2">
                    <input
                      type={azureKeyVisible ? "text" : "password"}
                      placeholder="Paste API key…"
                      value={azureKey}
                      onChange={(e) => setAzureKey(e.target.value)}
                      className="flex-1 border rounded px-3 py-1.5 text-sm font-mono"
                    />
                    <button
                      onClick={() => setAzureKeyVisible((v) => !v)}
                      className="text-xs text-gray-500 px-2 border rounded"
                    >
                      {azureKeyVisible ? "hide" : "show"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => void handleAzureTest()}
                  disabled={azureTesting}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
                >
                  {azureTesting ? "…" : "Test"}
                </button>
                <button
                  onClick={() => void handleAzureSave()}
                  className="px-3 py-1.5 text-sm bg-[#1B4F23] text-white rounded hover:bg-green-800"
                >
                  Save
                </button>
              </div>

              <p className="text-xs text-gray-400 mt-2">
                Your IT administrator can provide the endpoint URL, deployment name, and
                API key from the Azure Portal under your OpenAI resource → Keys and Endpoint.
                Environment variables:{" "}
                <code className="font-mono">AZURE_OPENAI_ENDPOINT</code>,{" "}
                <code className="font-mono">AZURE_OPENAI_DEPLOYMENT</code>,{" "}
                <code className="font-mono">AZURE_OPENAI_API_KEY</code>
              </p>

              {azureStatus !== null && (
                <p
                  className={`text-sm mt-2 ${azureStatus.ok ? "text-green-600" : "text-red-600"}`}
                >
                  {azureStatus.ok
                    ? `✓ OK · ${azureStatus.ms}ms`
                    : `✗ ${azureStatus.msg}`}
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ── Default Models ───────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Default Models
          </h2>
          <p className="text-xs text-gray-400 mb-4">
            These defaults are used when no model is selected in the review
            screens.  You can override per-session using the model selector in
            the MR and TMR review headers.
          </p>
          <div className="bg-white border border-gray-200 rounded-lg px-5 divide-y divide-gray-100">
            <ModelDropdown
              label="MR section generation"
              storageKey={LS_MR_MODEL}
              defaultModel={DEFAULT_MR_MODEL}
            />
            <ModelDropdown
              label="TMR sub-table generation"
              storageKey={LS_TMR_MODEL}
              defaultModel={DEFAULT_TMR_MODEL}
            />
          </div>
        </section>

        {/* ── Project Folder ───────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Project Folder
          </h2>
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
            {editingDir ? (
              <>
                <input
                  type="text"
                  value={dirInput}
                  onChange={(e) => setDirInput(e.target.value)}
                  className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                  placeholder="C:\Users\you\Documents\AgCensus"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveDir}
                    className="text-xs bg-[#1B4F23] text-white rounded-lg px-4 py-1.5 hover:bg-[#163d1c] transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingDir(false)}
                    className="text-xs border border-gray-200 rounded-lg px-3 py-1.5 text-gray-500 hover:border-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] text-gray-400 mb-0.5">
                    Current project base directory
                  </p>
                  <p className="text-xs font-mono text-gray-700 break-all">
                    {baseDir || (
                      <span className="italic text-gray-400">
                        Using default: ~/Documents/AgCensus
                      </span>
                    )}
                  </p>
                </div>
                <button
                  onClick={handleChangeDir}
                  className="shrink-0 text-xs border border-gray-200 rounded-lg px-3 py-1.5 text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-colors"
                >
                  Change
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ── About ───────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            About
          </h2>
          <div className="bg-white border border-gray-200 rounded-lg px-5 py-4 text-xs text-gray-500 space-y-1">
            <div className="flex items-center justify-between">
              <span>Ag Census MR TMR Compiler</span>
              <span className="font-mono text-gray-400">Session 25</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Supported providers</span>
              <span className="text-gray-400">
                DeepSeek · Kimi · Google · OpenAI · Anthropic · Azure
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Models available</span>
              <span className="text-gray-400">12 across 3 tiers</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default Settings;
