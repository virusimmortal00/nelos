#!/usr/bin/python3
"""Exercise exact launched-row AT-SPI classification and visual count semantics."""

import json
import pathlib
import sys


if len(sys.argv) != 3:
    raise SystemExit(64)

helper_path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
source = helper_path.read_text(encoding="utf8")
marker = "try: request=json.load(sys.stdin)"
if source.count(marker) != 1:
    raise SystemExit(65)
scope = {"__name__": "nelos_atspi_descendant_probe"}
exec(compile(source.split(marker, 1)[0], str(helper_path), "exec"), scope)


class FakeState:
    def __init__(self, values): self.values = set(values)
    def contains(self, value): return value in self.values


class FakeBox:
    def __init__(self, x, y, width, height): self.x, self.y, self.width, self.height = x, y, width, height


class FakeComponent:
    def __init__(self, geometry): self.geometry = geometry
    def getExtents(self, _coordinate_type): return FakeBox(*self.geometry)


class FakeNode:
    def __init__(self, role, *, name="", description="", attributes=(), geometry=(1, 1, 1, 1), states=None, children=()):
        self.role, self.name, self.description = role, name, description
        self.attributes, self.geometry = list(attributes), geometry
        self.states = set(states or ("showing", "visible")); self.children = []; self.parent = None
        for child in children: self.add(child)
    @property
    def childCount(self): return len(self.children)
    def add(self, child): child.parent = self; self.children.append(child); return child
    def getChildAtIndex(self, index): return self.children[index]
    def getRoleName(self): return self.role
    def getAttributes(self): return list(self.attributes)
    def getState(self): return FakeState(self.states)
    def queryComponent(self): return FakeComponent(self.geometry)


class FakeAtspi:
    STATE_BUSY = "busy"
    STATE_EXPANDED = "expanded"
    STATE_PRESSED = "pressed"
    STATE_SHOWING = "showing"
    STATE_VISIBLE = "visible"


scope["pyatspi"] = FakeAtspi
root_id = "01a01ae1-0000-7000-8000-000000000001"
descendants = [{
    "taskId": f"01a01ae1-0000-7000-8000-{index + 2:012d}",
    "parentTaskId": root_id,
    "title": f"Worker {index + 1}",
    "latestTurnId": f"turn-{index + 1}",
    "latestTurnStatus": "inProgress" if index < 4 else "completed",
} for index in range(7)]


def sidebar_tree():
    rows = []
    for index, expected in enumerate(descendants):
        attrs = [
            f"data-app-action-sidebar-thread-id:{expected['taskId']}",
            f"data-app-action-sidebar-thread-title:{expected['title']}",
        ]
        if mode == "missing-sidebar-id" and index == 0: attrs.pop(0)
        children = [FakeNode("label", name=expected["title"], geometry=(2, 2 + index * 8, 20, 3))]
        if index < 4: children.append(FakeNode("label", name="In progress", geometry=(23, 2 + index * 8, 10, 3)))
        rows.append(FakeNode("list item", attributes=attrs, geometry=(1, 1 + index * 8, 35, 7), children=children))
    sidebar = FakeNode("scroll pane", attributes=("data-app-action-sidebar-scroll:true",), geometry=(0, 0, 38, 70), children=rows)
    return FakeNode("frame", children=(sidebar,))


def mcp_tree(selected):
    rows = []
    for index, expected in enumerate(selected):
        native_running = expected["latestTurnStatus"] == "inProgress"
        rendered = "running" if native_running else "complete"
        label = "Running" if native_running else "Complete"
        title = expected["title"]
        if mode == "swapped-name" and len(selected) > 1 and index < 2: title = selected[1 - index]["title"]
        if mode == "swapped-status" and native_running and index == 0: rendered, label = "attention", "Attention"
        aria = "Open Codex task " + expected["taskId"]
        if mode == "wrong-mcp-aria" and index == 0: aria = "Open Codex task 01a01ae1-0000-7000-8000-999999999999"
        y = 20 + index * 8
        rows.append(FakeNode("list item", attributes=("class:member", f"data-status:{rendered}"), geometry=(42, y, 55, 7), children=(
            FakeNode("paragraph", name=title, attributes=("class:member-task",), geometry=(43, y + 1, 25, 3)),
            FakeNode("label", name=label, attributes=("class:status",), geometry=(69, y + 1, 10, 3)),
            FakeNode("link", name=aria, geometry=(80, y + 1, 16, 3)),
        )))
    mcp = FakeNode("group", name="Nelos task workers", geometry=(40, 0, 60, 80), children=rows)
    controls = [
        FakeNode("toggle button", name="Current 16", states=("showing", "visible", "pressed"), geometry=(40, 1, 15, 4)),
        FakeNode("toggle button", name="Done 3", geometry=(56, 1, 12, 4)),
        FakeNode("toggle button", name="In progress (4)", states=("showing", "visible", "expanded"), geometry=(40, 6, 18, 4)),
        FakeNode("toggle button", name="Queued (12)", states=("showing", "visible", "expanded"), geometry=(59, 6, 15, 4)),
        FakeNode("button", name="Show 1 more…", geometry=(40, 11, 15, 4)),
        FakeNode("button", name="Show 9 more…", geometry=(56, 11, 15, 4)),
    ]
    return FakeNode("frame", children=(*controls, mcp))


sidebar_root = sidebar_tree(); sidebar_scan, sidebar_parents = scope["complete_scan_index"](sidebar_root)
sidebar_children = scope["indexed_children"](sidebar_scan, sidebar_parents)
_sidebar, sidebar_rows, _sidebar_evidence = scope["visible_descendant_sidebar_rows"](sidebar_scan, sidebar_parents, sidebar_children, descendants)

current_root = mcp_tree(descendants[:4]); current_scan, current_parents = scope["complete_scan_index"](current_root)
current_children = scope["indexed_children"](current_scan, current_parents)
counts = scope["aggregate_task_counters"](current_scan)
_current, current_rows, _current_evidence = scope["visible_descendant_mcp_rows"](current_scan, current_parents, current_children, descendants[:4])

done_root = mcp_tree(descendants[4:]); done_scan, done_parents = scope["complete_scan_index"](done_root)
done_children = scope["indexed_children"](done_scan, done_parents)
_done, done_rows, _done_evidence = scope["visible_descendant_mcp_rows"](done_scan, done_parents, done_children, descendants[4:])

observed = {row["taskId"]: (row["title"], row["renderedStatus"]) for row in [*current_rows, *done_rows]}
expected = {row["taskId"]: (row["title"], "running" if row["latestTurnStatus"] == "inProgress" else "complete") for row in descendants}
sys.stdout.write(json.dumps({
    "counts": counts,
    "sidebarCount": len(sidebar_rows),
    "mcpCount": len(current_rows) + len(done_rows),
    "matchesExpected": observed == expected,
    "showMore": ["Show 1 more…", "Show 9 more…"],
}, separators=(",", ":")))
