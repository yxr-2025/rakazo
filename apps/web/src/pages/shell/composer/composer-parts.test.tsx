// @vitest-environment jsdom

import type { ComposerMention } from "@rakazo/core";
import { buildComposerMentionOptions, mentionConnectorsFrom } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MentionPicker } from "./composer-parts";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

it("uses the visible names and types of same-name bots and groups as option labels", async () => {
  const bot = { kind: "bot", id: "bot-1", name: "Design", subtitle: "Bot" } as const;
  const group = { kind: "group", id: "group-1", name: "Design", subtitle: "Group" } as const;
  const routine = {
    kind: "routine",
    id: "routine-1",
    name: "Notes",
    subtitle: "Every day",
  } as const;
  const withoutSubtitle = { kind: "bot", id: "bot-2", name: "Planner" } as const;
  const uniqueBot = { kind: "bot", id: "bot-3", name: "Writer", subtitle: "Bot" } as const;
  const options: ComposerMention[] = [bot, group, routine, withoutSubtitle, uniqueBot];
  const onPick = vi.fn();
  const onHighlight = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);

  try {
    await act(async () =>
      root.render(
        <MentionPicker
          listboxId="test-mentions"
          options={options}
          activeIndex={1}
          onPick={onPick}
          onHighlight={onHighlight}
        />,
      ),
    );

    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(rows).toHaveLength(5);
    const labelledByText = (option: HTMLButtonElement | undefined) =>
      option
        ?.getAttribute("aria-labelledby")
        ?.split(" ")
        .map((id) => document.getElementById(id)?.textContent);
    expect(labelledByText(rows[0])).toEqual(["@Design", "Bot"]);
    expect(labelledByText(rows[1])).toEqual(["@Design", "Group"]);
    expect(rows[2]?.getAttribute("aria-labelledby")).toBeNull();
    expect(rows[2]?.getAttribute("aria-label")).toBe("@Notes");
    expect(rows[3]?.getAttribute("aria-labelledby")).toBeNull();
    expect(rows[3]?.getAttribute("aria-label")).toBe("@Planner");
    expect(rows[4]?.getAttribute("aria-labelledby")).toBeNull();
    expect(rows[4]?.getAttribute("aria-label")).toBe("@Writer");
    expect(rows.map((option) => option.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(rows[1]?.id).toBe("test-mentions-option-1");

    await act(async () => rows[1]?.click());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(group);
    expect(onHighlight).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("announces the kind of a routine or connector that shares a bot's name", async () => {
  const options = buildComposerMentionOptions({
    query: "",
    bots: [
      { id: "bot-notes", name: "Weekly Notes" },
      { id: "bot-notion", name: "Notion" },
      { id: "bot-writer", name: "Writer" },
    ],
    groups: [],
    routines: [
      {
        id: "routine-notes",
        name: "Weekly Notes",
        crons: ["0 9 * * 1"],
        botId: "bot-notes",
      },
    ],
    connectors: mentionConnectorsFrom(
      [],
      [
        {
          connectorId: "connector-notion",
          slug: "notion",
          name: "Notion",
          connected: false,
          noAuth: false,
        },
      ],
    ),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);

  try {
    await act(async () =>
      root.render(
        <MentionPicker
          listboxId="test-mentions"
          options={options}
          activeIndex={3}
          onPick={vi.fn()}
          onHighlight={vi.fn()}
        />,
      ),
    );
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(
      rows.map((option) => {
        const ids = option.getAttribute("aria-labelledby");
        return ids
          ? ids.split(" ").map((id) => document.getElementById(id)?.textContent)
          : option.getAttribute("aria-label");
      }),
    ).toEqual([
      ["@Weekly Notes", "Bot"],
      ["@Notion", "Bot"],
      "@Writer",
      ["@Weekly Notes", "Routine"],
      ["@Notion", "Connector"],
    ]);
    expect(rows[3]?.textContent).toContain("Every Monday at 9:00 AM");
    expect(rows[4]?.textContent).toContain("Needs auth");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
