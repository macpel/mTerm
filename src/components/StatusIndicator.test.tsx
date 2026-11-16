import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({ t: (key: string) => key }));

import type { DisplayStatus } from "../types";
import { StatusIndicator } from "./StatusIndicator";

const view = (status: DisplayStatus, unread = false, label = true) =>
  render(<StatusIndicator status={status} unread={unread} label={label} />).container;

describe("StatusIndicator", () => {
  it("keeps the plain dot without a label", () => {
    const el = view("working", false, false);
    expect(el.querySelector(".status-label")).toBeNull();
    expect(el.querySelector(".status-dot.st-working")?.getAttribute("title")).toBe("status.working");
  });

  it.each([
    ["working", "status.short.working", "st-working"],
    ["asking", "status.short.asking", "st-attention"],
    ["waiting", "status.short.waiting", "st-waiting"],
    ["background", "status.short.background", "st-background"],
    ["error", "status.short.error", "st-error"],
    ["unavailable", "status.short.unavailable", "st-unavailable"],
    ["running", "status.short.running", "st-ready"],
  ] as const)("labels %s with its word and dot color", (status, word, dot) => {
    const el = view(status);
    expect(el.querySelector(".status-label")?.textContent).toBe(word);
    expect(el.querySelector(`.status-dot.${dot}`)).not.toBeNull();
  });

  it("unread says the reply is new, but keeps a question or background work", () => {
    expect(view("waiting", true).querySelector(".status-label")?.textContent).toBe("status.short.unread");
    expect(view("asking", true).querySelector(".status-label")?.textContent).toBe("status.short.asking");
    expect(view("background", true).querySelector(".status-label")?.textContent).toBe("status.short.background");
    expect(view("waiting", true).querySelector(".status-dot.st-unread")).not.toBeNull();
  });

  it("shows nothing for idle and exited sessions", () => {
    expect(view("idle").innerHTML).toBe("");
    expect(view("exited").innerHTML).toBe("");
  });
});
