import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BROWSER_SHORTCUTS } from "../../../store/settings";
import { useTermStore } from "../../../store/termStore";
import { BrowserQuickAccess, normalizeShortcutUrl } from "./BrowserQuickAccess";

vi.mock("../../../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../i18n")>()),
  useT: () => (key: string) => key,
}));

const labels = () => useTermStore.getState().browserShortcuts.map((s) => s.label);

/** Opens the context menu on a shortcut, or on the empty bar when no name is given. */
function rightClick(name?: string) {
  const target = name ? screen.getByRole("button", { name }) : screen.getByRole("navigation", { name: "Quick access" });
  fireEvent.contextMenu(target, { clientX: 10, clientY: 10 });
}

function choose(label: string) {
  fireEvent.click(screen.getByText(label));
}

/** Field labels may carry a required marker, so match on the key rather than the exact text. */
const field = (key: "browser.shortcutName" | "browser.shortcutUrl") =>
  screen.getByLabelText(new RegExp(key.replace(".", "\\."))) as HTMLInputElement;
const queryField = (key: string) => screen.queryByLabelText(new RegExp(key.replace(".", "\\.")));

function fill(key: "browser.shortcutName" | "browser.shortcutUrl", value: string) {
  fireEvent.change(field(key), { target: { value } });
}

/** FormModal has no <form>; Enter in a field submits it. */
function submit() {
  fireEvent.keyDown(field("browser.shortcutName"), { key: "Enter" });
}

describe("BrowserQuickAccess", () => {
  beforeEach(() => {
    // Saving settings re-applies visual settings, which reads matchMedia; jsdom has none.
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useTermStore.getState().setBrowserShortcuts(DEFAULT_BROWSER_SHORTCUTS.map((s) => ({ ...s })));
  });

  it("renders every saved shortcut by name", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    expect(screen.getByRole("navigation", { name: "Quick access" })).toBeTruthy();
    for (const site of DEFAULT_BROWSER_SHORTCUTS) {
      expect(screen.getByRole("button", { name: site.label })).toBeTruthy();
    }
  });

  it("navigates the current browser tab when a shortcut is clicked", () => {
    const onNavigate = vi.fn();
    render(<BrowserQuickAccess label="Quick access" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Gemini" }));

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("https://gemini.google.com/");
  });

  it("deletes a shortcut from its context menu", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    rightClick("Claude");
    choose("browser.shortcutDelete");

    expect(labels()).toEqual(["ChatGPT", "Gemini", "Google"]);
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
  });

  it("adds a named shortcut and fills in https://", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    rightClick();
    choose("browser.shortcutAdd…");
    fill("browser.shortcutName", "GitHub");
    fill("browser.shortcutUrl", "github.com");
    submit();

    const added = useTermStore.getState().browserShortcuts.at(-1)!;
    expect(added).toMatchObject({ label: "GitHub", url: "https://github.com/" });
    expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
  });

  it("adds the current page with its title, which can be renamed first", () => {
    render(
      <BrowserQuickAccess
        label="Quick access"
        onNavigate={() => {}}
        current={{ url: "https://docs.example.com/guide", title: "The Guide" }}
      />,
    );

    rightClick();
    choose("browser.shortcutAddCurrent…");
    expect(field("browser.shortcutName").value).toBe("The Guide");
    expect(field("browser.shortcutUrl").value).toBe("https://docs.example.com/guide");
    fill("browser.shortcutName", "Docs");
    submit();

    expect(useTermStore.getState().browserShortcuts.at(-1)).toMatchObject({
      label: "Docs",
      url: "https://docs.example.com/guide",
    });
  });

  it("disables Add current page on a blank tab", () => {
    render(
      <BrowserQuickAccess label="Quick access" onNavigate={() => {}} current={{ url: "about:blank", title: "" }} />,
    );

    rightClick();

    expect(screen.getByText("browser.shortcutAddCurrent…").closest("[aria-disabled='true'],button:disabled,[disabled]")).toBeTruthy();
  });

  it("renames a shortcut without changing its address", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    rightClick("Google");
    choose("browser.shortcutRename…");
    expect(queryField("browser.shortcutUrl")).toBeNull();
    fill("browser.shortcutName", "Search");
    submit();

    expect(useTermStore.getState().browserShortcuts.find((s) => s.id === "google")).toEqual({
      id: "google",
      label: "Search",
      url: "https://www.google.com/",
    });
  });

  it("edits a shortcut's name and address in place", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    rightClick("ChatGPT");
    choose("browser.shortcutEdit…");
    fill("browser.shortcutName", "Chat");
    fill("browser.shortcutUrl", "https://chat.openai.com/");
    submit();

    const list = useTermStore.getState().browserShortcuts;
    expect(list[0]).toEqual({ id: "chatgpt", label: "Chat", url: "https://chat.openai.com/" });
    expect(list).toHaveLength(4);
  });

  it("blocks an empty name or an unsupported address", () => {
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    rightClick();
    choose("browser.shortcutAdd…");
    expect(screen.queryByRole("alert")).toBeNull();
    fill("browser.shortcutName", "   ");
    fill("browser.shortcutUrl", "example.com");
    submit();
    expect(labels()).toHaveLength(4);

    fill("browser.shortcutName", "Files");
    fill("browser.shortcutUrl", "file:///etc/passwd");
    submit();
    expect(screen.getByText("browser.shortcutInvalidUrl")).toBeTruthy();
    expect(labels()).toHaveLength(4);
  });

  it("restores the default shortcuts", () => {
    useTermStore.getState().setBrowserShortcuts([]);
    render(<BrowserQuickAccess label="Quick access" onNavigate={() => {}} />);

    rightClick();
    choose("browser.shortcutReset");

    expect(labels()).toEqual(["ChatGPT", "Claude", "Gemini", "Google"]);
  });
});

describe("normalizeShortcutUrl", () => {
  it("accepts http(s) and adds https:// to a bare host", () => {
    expect(normalizeShortcutUrl("example.com")).toBe("https://example.com/");
    expect(normalizeShortcutUrl(" http://localhost:3000/x ")).toBe("http://localhost:3000/x");
  });

  it("rejects other schemes, spaces and empty input", () => {
    expect(normalizeShortcutUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeShortcutUrl("file:///c:/x")).toBeNull();
    expect(normalizeShortcutUrl("not a url")).toBeNull();
    expect(normalizeShortcutUrl("")).toBeNull();
  });
});
