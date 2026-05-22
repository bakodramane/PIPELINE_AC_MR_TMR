/**
 * AgCensus Compiler — root component.
 *
 * Manages the four-screen state machine:
 *   list              → country project list (Screen 1, default)
 *   project-overview  → per-project hub with metrics and nav tabs
 *   mr-review         → MR section review for one project
 *   tmr-review        → TMR sub-table review for one project
 *
 * Also hosts the global toast notification system so any screen can
 * surface messages to the user.
 */

import { useState, useCallback, useEffect } from "react";
import ProjectList from "./screens/ProjectList";
import ProjectOverview from "./screens/ProjectOverview";
import MrReview from "./screens/MrReview";
import TmrReview from "./screens/TmrReview";
import AuditLog from "./screens/AuditLog";
import type { ProjectInfo, ToastMessage } from "./types/ui";

// ---------------------------------------------------------------------------
// Screen state machine
// ---------------------------------------------------------------------------

type Screen =
  | { id: "list" }
  | { id: "project-overview"; project: ProjectInfo }
  | { id: "mr-review"; project: ProjectInfo }
  | { id: "tmr-review"; project: ProjectInfo }
  | { id: "audit-log"; project: ProjectInfo };

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

let _nextToastId = 0;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ id: "list" });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

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

  // Reset scroll to top on screen change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

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
    }
  }

  return (
    <>
      {renderScreen()}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
