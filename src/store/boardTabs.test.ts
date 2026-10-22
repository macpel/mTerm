//! Board tab state: one tab per project, no pane tree, client-local like task tabs.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", () => ({
  createWorktree: vi.fn(),
  getSessionCwd: vi.fn().mockResolvedValue(null),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  listShells: vi.fn().mockResolvedValue([]),
}));
vi.mock("../ipc/tree", () => {
  const s = (id: string) => ({
    id,
    projectId: "p1",
    groupId: null,
    name: id,
    kind: "claude",
    shell: null,
    cwd: "/tmp",
    envJson: null,
    initCmd: null,
    hotkey: null,
    parentSessionId: null,
    collapsed: false,
    worktreePath: null,
    sortOrder: 0,
    createdAt: 0,
  });
  return {
    listTree: vi.fn().mockResolvedValue({
      projects: [
        { id: "p1", name: "P", rootPath: "/tmp", color: null, sortOrder: 0, collapsed: false, createdAt: 0 },
      ],
      groups: [],
      sessions: [s("A"), s("B")],
    }),
  };
});
vi.mock("../notify", () => ({ notify: vi.fn() }));
// Browser-node openSession is desktop-only behind isTauri || isElectron, so tests emulate desktop.
vi.mock("../ipc/transport", () => ({ isTauri: true }));
// Stub env instead of loading real platform adapters, which would require unrelated transport exports.
vi.mock("../platform", () => ({
  env: {
    kind: "tauri",
    isTauri: true,
    isElectron: false,
    isBrowser: false,
    isRemoteWindow: false,
    hasNativeHost: true,
    isMac: false,
  },
}));
vi.mock("../ipc/browser", () => ({ setBrowserUrl: vi.fn().mockResolvedValue(undefined) }));
// Stub the platform as desktop Tauri, consistent with transport's isTauri:true, without loading
// adapter chains that require additional transport/notify exports.
vi.mock("../platform", () => {
  const env = {
    kind: "tauri",
    isTauri: true,
    isElectron: false,
    isBrowser: false,
    isRemoteWindow: false,
    hasNativeHost: true,
    isMac: false,
  };
  return { env, platform: { env, dialog: { pickDirectory: vi.fn(), saveFile: vi.fn() } } };
});

import type { Session } from "../types";
import { useTermStore } from "./termStore";
import { buildMirrorLayout } from "./mirrorLayout";

function mkSession(id: string): Session {
  return {
    id,
    projectId: "p1",
    groupId: null,
    name: id,
    kind: "claude",
    shell: null,
    cwd: "/tmp",
    envJson: null,
    initCmd: null,
    hotkey: null,
    parentSessionId: null,
    collapsed: false,
    worktreePath: null,
    sortOrder: 0,
    createdAt: 0,
  };
}

/** Reset to project p1, named sessions A/B, an empty center pane, and single-tab mode. */
function seed() {
  useTermStore.setState({
    projects: [
      { id: "p1", name: "P", rootPath: "/tmp", color: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ],
    groups: [],
    sessions: [mkSession("A"), mkSession("B")],
    runtimes: { A: { status: "idle" }, B: { status: "idle" } },
    epochs: {},
    ephemeralSessions: {},
    pendingPrompts: {},
    openTabs: [],
    activeTabId: null,
    paneTrees: {},
    activeSessionId: null,
    focusedPaneId: null,
    liveTabs: [],
    docTabs: {},
    browserTabs: {},
    taskTabs: {},
    boardTabs: {},
    notifications: {},
    singleTabMode: true,
  });
}

afterEach(() => {
  localStorage.clear();
});

describe("board tabs", () => {
  it("opens one tab per project", () => {
    seed();
    useTermStore.getState().openBoardTab("p1");
    useTermStore.getState().openBoardTab("p1");
    const s = useTermStore.getState();
    expect(s.openTabs).toEqual(["board-p1"]);
    expect(s.boardTabs["board-p1"]).toEqual({ id: "board-p1", projectId: "p1" });
    expect(s.activeTabId).toBe("board-p1");
    expect(s.activeSessionId).toBeNull();
  });

  it("closeTab removes the board tab", () => {
    seed();
    useTermStore.getState().openBoardTab("p1");
    useTermStore.getState().closeTab("board-p1");
    const s = useTermStore.getState();
    expect(s.openTabs).toEqual([]);
    expect(s.boardTabs).toEqual({});
  });

  it("reconcileTabs keeps an open board tab", async () => {
    seed();
    useTermStore.getState().openBoardTab("p1");
    await useTermStore.getState().loadTree();
    await useTermStore.getState().loadTree();
    expect(useTermStore.getState().openTabs).toContain("board-p1");
    expect(useTermStore.getState().boardTabs["board-p1"]).toBeDefined();
  });

  it("mirror layout never publishes a board tab", () => {
    seed();
    useTermStore.getState().openBoardTab("p1");
    const layout = buildMirrorLayout(useTermStore.getState());
    expect(layout.center.openTabs).not.toContain("board-p1");
    expect(layout.center.activeTabId).not.toBe("board-p1");
  });
});
