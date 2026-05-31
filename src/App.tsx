/**
 * AgCensus Compiler — root component.
 *
 * Manages the five-screen state machine:
 *   list              → country project list (Screen 1, default)
 *   project-overview  → per-project hub with metrics and nav tabs
 *   mr-review         → MR section review for one project
 *   tmr-review        → TMR sub-table review for one project
 *   audit-log         → audit event log for one project
 *   settings          → API keys, default models, project folder
 *
 * A fixed gear icon in the bottom-left corner opens Settings from any screen.
 * Dismissing Settings returns to the screen that was active before.
 *
 * Also hosts the global toast notification system so any screen can
 * surface messages to the user.
 *
 * Session 18: added Settings screen + gear icon overlay.
 */

import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProjectList from "./screens/ProjectList";
import ProjectOverview from "./screens/ProjectOverview";
import MrReview from "./screens/MrReview";
import TmrReview from "./screens/TmrReview";
import AuditLog from "./screens/AuditLog";
import Settings from "./screens/Settings";
import type { ProjectInfo, ToastMessage } from "./types/ui";

// ---------------------------------------------------------------------------
// Screen state machine
// ---------------------------------------------------------------------------

type NonSettingsScreen =
  | { id: "list" }
  | { id: "project-overview"; project: ProjectInfo }
  | { id: "mr-review"; project: ProjectInfo }
  | { id: "tmr-review"; project: ProjectInfo }
  | { id: "audit-log"; project: ProjectInfo };

type Screen = NonSettingsScreen | { id: "settings" };

// ---------------------------------------------------------------------------
// Toast component
// ---------------------------------------------------------------------------

const TOAST_TYPE_STYLES: Record<
  ToastMessage["type"],
  { bg: string; border: string; icon: string }
> = {
  info: {
    bg: "bg-white",
    border: "border-gray-200",
    icon: "ℹ️",
  },
  success: {
    bg: "bg-green-50",
    border: "border-green-200",
    icon: "✓",
  },
  error: {
    bg: "bg-red-50",
    border: "border-red-200",
    icon: "✗",
  },
  warning: {
    bg: "bg-yellow-50",
    border: "border-yellow-200",
    icon: "⚠",
  },
};

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: () => void;
}) {
  const style = TOAST_TYPE_STYLES[toast.type];
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border shadow-lg px-4 py-3 max-w-sm ${style.bg} ${style.border}`}
    >
      <span className="text-sm shrink-0 mt-0.5">{style.icon}</span>
      <p className="text-xs text-gray-700 flex-1 leading-relaxed whitespace-pre-line">
        {toast.message}
      </p>
      <button
        onClick={onDismiss}
        className="text-gray-300 hover:text-gray-500 text-sm leading-none shrink-0 mt-0.5"
      >
        ×
      </button>
    </div>
  );
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-[100] pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast toast={t} onDismiss={() => onDismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node.js missing screen
// ---------------------------------------------------------------------------

function NodeMissingScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="max-w-md w-full bg-white rounded-xl border border-red-200 shadow-lg p-8 text-center">
        <div className="text-4xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold text-gray-900 mb-3">
          Node.js is required
        </h1>
        <p className="text-sm text-gray-600 mb-6 leading-relaxed">
          Node.js was not found on your system. Generation and ingest features
          require Node.js to be installed.
          <br /><br />
          Please install the LTS version from{" "}
          <strong>nodejs.org</strong>, then restart this application.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => {
              void (async () => {
                try {
                  await invoke("open_path", { path: "https://nodejs.org" });
                } catch {
                  window.open("https://nodejs.org", "_blank");
                }
              })();
            }}
            className="px-4 py-2 text-sm font-medium bg-[#1B4F23] text-white rounded-lg hover:bg-[#163d1c] transition-colors"
          >
            Open nodejs.org
          </button>
          <button
            onClick={onRetry}
            className="px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

let _nextToastId = 0;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ id: "list" });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [nodeOk, setNodeOk] = useState<boolean | null>(null); // null = checking
  // Track where to return after closing Settings
  const [prevScreen, setPrevScreen] = useState<NonSettingsScreen>({
    id: "list",
  });

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastMessage["type"] = "info") => {
      const id = _nextToastId++;
      setToasts((prev) => [...prev, { id, message, type }]);
      // Auto-dismiss: 7 s for error/warning, 3.5 s for info/success
      const delay = type === "error" || type === "warning" ? 7000 : 3500;
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, delay);
    },
    [],
  );

  // Check Node.js availability on startup (and on retry)
  const checkNode = useCallback(() => {
    setNodeOk(null);
    void invoke<string>("check_node_available")
      .then(() => setNodeOk(true))
      .catch(() => setNodeOk(false));
  }, []);

  useEffect(() => {
    checkNode();
  }, [checkNode]);

  // Reset scroll to top on screen change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  function openSettings() {
    if (screen.id !== "settings") {
      setPrevScreen(screen as NonSettingsScreen);
    }
    setScreen({ id: "settings" });
  }

  function closeSettings() {
    setScreen(prevScreen);
  }

  function renderScreen() {
    switch (screen.id) {
      case "list":
        return (
          <ProjectList
            onOpenProject={(project) =>
              setScreen({ id: "project-overview", project })
            }
            onToast={addToast}
          />
        );

      case "project-overview":
        return (
          <ProjectOverview
            project={screen.project}
            onBack={() => setScreen({ id: "list" })}
            onOpenMrReview={() =>
              setScreen({ id: "mr-review", project: screen.project })
            }
            onOpenTmrReview={() =>
              setScreen({ id: "tmr-review", project: screen.project })
            }
            onOpenAuditLog={() =>
              setScreen({ id: "audit-log", project: screen.project })
            }
            onToast={addToast}
          />
        );

      case "mr-review":
        return (
          <MrReview
            projectDir={screen.project.dir}
            projectName={`${screen.project.manifest.country} ${screen.project.manifest.reference_year}`}
            onBack={() =>
              setScreen({ id: "project-overview", project: screen.project })
            }
            onSwitchToTmr={() =>
              setScreen({ id: "tmr-review", project: screen.project })
            }
            onToast={addToast}
          />
        );

      case "tmr-review":
        return (
          <TmrReview
            projectDir={screen.project.dir}
            projectName={`${screen.project.manifest.country} ${screen.project.manifest.reference_year}`}
            onBack={() =>
              setScreen({ id: "project-overview", project: screen.project })
            }
            onSwitchToMr={() =>
              setScreen({ id: "mr-review", project: screen.project })
            }
            onToast={addToast}
          />
        );

      case "audit-log":
        return (
          <AuditLog
            projectDir={screen.project.dir}
            projectName={`${screen.project.manifest.country} ${screen.project.manifest.reference_year}`}
            onBack={() =>
              setScreen({ id: "project-overview", project: screen.project })
            }
            onToast={addToast}
          />
        );

      case "settings":
        return (
          <Settings
            onBack={closeSettings}
            onToast={addToast}
          />
        );
    }
  }

  // Show spinner while checking, error screen if Node missing
  if (nodeOk === null) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gray-200 border-t-[#1B4F23] rounded-full animate-spin" />
      </div>
    );
  }
  if (nodeOk === false) {
    return <NodeMissingScreen onRetry={checkNode} />;
  }

  return (
    <>
      {renderScreen()}

      {/* Gear icon — fixed overlay, visible on all non-settings screens */}
      {screen.id !== "settings" && (
        <button
          onClick={openSettings}
          title="Settings"
          className="fixed bottom-4 left-4 z-50 w-9 h-9 flex items-center justify-center rounded-full bg-white border border-gray-200 shadow-md text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-colors text-base"
        >
          ⚙
        </button>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
