//! Quick-access bar for the built-in browser. The shortcut list lives in settings (`browserShortcuts`) and is
//! edited from the bar's context menu: add, add the current page, rename, edit, remove, and reset to defaults.
//! This component only renders and dispatches callbacks. BrowserView still navigates through browserNavigate to keep Tauri and Electron consistent.

import { useState } from "react";
import { siClaude, siGoogle, siGooglegemini, type SimpleIcon } from "simple-icons";
import { openAiMarkEl } from "../../../components/brandIcons";
import { ContextMenu, type MenuItem } from "../../../components/ContextMenu";
import { FormModal, type FieldDef } from "../../../components/FormModal";
import Icons from "../../../components/Icons";
import { stripControlChars } from "../../../hooks/textInputGuards";
import { genId } from "../../../genId";
import { useT } from "../../../i18n";
import {
  BROWSER_SHORTCUT_NAME_MAX,
  DEFAULT_BROWSER_SHORTCUTS,
  type BrowserShortcut,
} from "../../../store/settings";
import { useTermStore } from "../../../store/termStore";

/** Brand icon and colour for the built-in shortcuts; any other shortcut shows a globe. */
const BUILTIN_ICONS: Record<string, { color: string; icon?: SimpleIcon }> = {
  chatgpt: { color: "#10A37F" },
  claude: { color: `#${siClaude.hex}`, icon: siClaude },
  gemini: { color: `#${siGooglegemini.hex}`, icon: siGooglegemini },
  google: { color: `#${siGoogle.hex}`, icon: siGoogle },
};

function SimpleBrandIcon({ icon }: { icon: SimpleIcon }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}

function ShortcutIcon({ id }: { id: string }) {
  const brand = BUILTIN_ICONS[id];
  if (!brand) return <span aria-hidden="true" style={{ display: "inline-flex" }}><Icons.globe size={13} /></span>;
  return (
    <span aria-hidden="true" style={{ color: brand.color, display: "inline-flex", alignItems: "center" }}>
      {brand.icon ? <SimpleBrandIcon icon={brand.icon} /> : openAiMarkEl(14)}
    </span>
  );
}

/** Turns typed input into an http(s) URL, adding `https://` to a bare host; returns null for anything else. */
export function normalizeShortcutUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

const cleanName = (raw: string) => stripControlChars(raw).trim().slice(0, BROWSER_SHORTCUT_NAME_MAX);

/** Name for "Add current page": the page title, or its host when the page has none. */
function pageName(current: { url: string; title: string }) {
  const title = cleanName(current.title);
  if (title) return title;
  try {
    return new URL(current.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type Dialog =
  | { mode: "add"; initial: { name: string; url: string } }
  | { mode: "rename" | "edit"; shortcut: BrowserShortcut };

export function BrowserQuickAccess({
  label,
  onNavigate,
  current,
}: {
  label: string;
  onNavigate: (url: string) => void;
  /** The tab's page, offered by "Add current page"; omitted or about:blank disables it. */
  current?: { url: string; title: string };
}) {
  const t = useT();
  const shortcuts = useTermStore((s) => s.browserShortcuts);
  const setShortcuts = useTermStore((s) => s.setBrowserShortcuts);
  const [menu, setMenu] = useState<{ x: number; y: number; shortcut?: BrowserShortcut } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const canAddCurrent = !!current && normalizeShortcutUrl(current.url) !== null;

  const openMenu = (e: React.MouseEvent, shortcut?: BrowserShortcut) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, shortcut });
  };

  const menuItems = (shortcut?: BrowserShortcut): MenuItem[] => {
    const common: MenuItem[] = [
      { label: `${t("browser.shortcutAdd")}…`, onClick: () => setDialog({ mode: "add", initial: { name: "", url: "" } }) },
      {
        label: `${t("browser.shortcutAddCurrent")}…`,
        disabled: !canAddCurrent,
        onClick: () => current && setDialog({ mode: "add", initial: { name: pageName(current), url: current.url } }),
      },
      { label: t("browser.shortcutReset"), onClick: () => setShortcuts(DEFAULT_BROWSER_SHORTCUTS.map((s) => ({ ...s }))) },
    ];
    if (!shortcut) return common;
    return [
      { label: `${t("browser.shortcutRename")}…`, onClick: () => setDialog({ mode: "rename", shortcut }) },
      { label: `${t("browser.shortcutEdit")}…`, onClick: () => setDialog({ mode: "edit", shortcut }) },
      {
        label: t("browser.shortcutDelete"),
        danger: true,
        onClick: () => setShortcuts(shortcuts.filter((s) => s.id !== shortcut.id)),
      },
      { label: "", separator: true },
      ...common,
    ];
  };

  const nameField: FieldDef = { key: "name", label: t("browser.shortcutName"), required: true, autoFocus: true };
  const urlField: FieldDef = { key: "url", label: t("browser.shortcutUrl"), placeholder: "https://example.com", required: true };

  const renderDialog = () => {
    if (!dialog) return null;
    const withUrl = dialog.mode !== "rename";
    const initial =
      dialog.mode === "add"
        ? dialog.initial
        : { name: dialog.shortcut.label, url: dialog.shortcut.url };
    const title =
      dialog.mode === "add"
        ? t("browser.shortcutAdd")
        : dialog.mode === "rename"
          ? t("browser.shortcutRename")
          : t("browser.shortcutEdit");
    return (
      <FormModal
        title={title}
        fields={withUrl ? [nameField, urlField] : [nameField]}
        initial={initial}
        // Empty fields are already blocked as required; only flag an address once something invalid is typed.
        validate={(v) =>
          withUrl && (v.url ?? "").trim() && !normalizeShortcutUrl(v.url ?? "") ? t("browser.shortcutInvalidUrl") : null
        }
        onCancel={() => setDialog(null)}
        onSubmit={(v) => {
          const name = cleanName(v.name ?? "");
          // A name made only of control characters passes the required check but is empty once cleaned.
          if (!name) return;
          if (dialog.mode === "add") {
            setShortcuts([...shortcuts, { id: genId(), label: name, url: normalizeShortcutUrl(v.url ?? "")! }]);
          } else {
            const id = dialog.shortcut.id;
            const url = withUrl ? normalizeShortcutUrl(v.url ?? "")! : dialog.shortcut.url;
            setShortcuts(shortcuts.map((s) => (s.id === id ? { ...s, label: name, url } : s)));
          }
          setDialog(null);
        }}
      />
    );
  };

  return (
    <>
      <nav
        className="browser-quick-access"
        aria-label={label}
        onContextMenu={(e) => openMenu(e)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          minHeight: 32,
          padding: "3px 8px",
          overflowX: "auto",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-1)",
          flex: "none",
        }}
      >
        {shortcuts.map((site) => (
          <button
            key={site.id}
            type="button"
            title={site.url}
            aria-label={site.label}
            onClick={() => onNavigate(site.url)}
            onContextMenu={(e) => openMenu(e, site)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 25,
              padding: "0 9px",
              flex: "none",
              border: "1px solid transparent",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: 11.5,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-3, rgba(128,128,128,0.12))";
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "transparent";
              e.currentTarget.style.color = "var(--text-dim)";
            }}
          >
            <ShortcutIcon id={site.id} />
            <span>{site.label}</span>
          </button>
        ))}
        {/* An empty bar keeps its height and fills the space, so it can still be right-clicked to add one. */}
        <span style={{ flex: 1, alignSelf: "stretch", minWidth: 24 }} title={shortcuts.length ? undefined : t("browser.shortcutAdd")} />
      </nav>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.shortcut)} onClose={() => setMenu(null)} />}
      {renderDialog()}
    </>
  );
}
