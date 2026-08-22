#!/usr/bin/python3
"""Exercise the production archive classifier against a bounded fake AT-SPI tree."""

import json
import pathlib
import sys


if len(sys.argv) != 3:
    raise SystemExit(64)

helper_path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
valid_modes = {
    "valid", "clean-tree", "aliased", "collapsed-created", "duplicate-mcp",
    "missing-created", "show-more", "missing-sidebar-id", "wrong-sidebar-id",
    "missing-created-status", "wrong-created-status", "missing-mcp-aria",
    "wrong-mcp-aria",
}
if mode not in valid_modes:
    raise SystemExit(64)
source = helper_path.read_text(encoding="utf8")
marker = "try: request=json.load(sys.stdin)"
if source.count(marker) != 1:
    raise SystemExit(65)

scope = {"__name__": "nelos_atspi_archive_probe"}
exec(compile(source.split(marker, 1)[0], str(helper_path), "exec"), scope)


class FakeState:
    def __init__(self, values):
        self.values = set(values)

    def contains(self, value):
        return value in self.values


class FakeBox:
    def __init__(self, x, y, width, height):
        self.x = x
        self.y = y
        self.width = width
        self.height = height


class FakeComponent:
    def __init__(self, geometry):
        self.geometry = geometry

    def getExtents(self, _coordinate_type):
        return FakeBox(*self.geometry)


class FakeNode:
    def __init__(self, role, *, name="", description="", attributes=(), geometry=(1, 1, 1, 1), states=None, children=()):
        self.role = role
        self.name = name
        self.description = description
        self.attributes = list(attributes)
        self.geometry = geometry
        self.states = set(states or ("showing", "visible"))
        self.children = []
        self.parent = None
        for child in children:
            self.add(child)

    @property
    def childCount(self):
        return len(self.children)

    def add(self, child):
        child.parent = self
        self.children.append(child)
        return child

    def getChildAtIndex(self, index):
        return self.children[index]

    def getRoleName(self):
        return self.role

    def getAttributes(self):
        return list(self.attributes)

    def getState(self):
        return FakeState(self.states)

    def queryComponent(self):
        return FakeComponent(self.geometry)


class FakeAtspi:
    STATE_BUSY = "busy"
    STATE_EXPANDED = "expanded"
    STATE_PRESSED = "pressed"
    STATE_SHOWING = "showing"
    STATE_VISIBLE = "visible"


scope["pyatspi"] = FakeAtspi

thread_ids = [
    "01a01ae1-0000-7000-8000-000000000001",
    "01a01ae1-0000-7000-8000-000000000002",
    "01a01ae1-0000-7000-8000-000000000003",
]
expected = [
    {"threadId": thread_ids[0], "title": "Sidebar scenario"},
    {"threadId": thread_ids[1], "title": "Created scenario"},
    {"threadId": thread_ids[2], "title": "MCP scenario"},
]

sidebar_title = FakeNode("label", name=expected[0]["title"], geometry=(2, 2, 20, 4))
sidebar_attributes = [
    f"data-app-action-sidebar-thread-id:{thread_ids[0]}",
    f"data-app-action-sidebar-thread-title:{expected[0]['title']}",
]
if mode == "missing-sidebar-id":
    sidebar_attributes.pop(0)
elif mode == "wrong-sidebar-id":
    sidebar_attributes[0] = "data-app-action-sidebar-thread-id:01a01ae1-0000-7000-8000-999999999999"
sidebar_row = FakeNode(
    "list item",
    attributes=sidebar_attributes,
    geometry=(1, 1, 24, 8),
    children=(sidebar_title,),
)
sidebar = FakeNode(
    "scroll pane",
    attributes=("data-app-action-sidebar-scroll:true",),
    geometry=(0, 0, 25, 80),
    children=(sidebar_row,),
)

toggle_states = {"showing", "visible", "pressed"}
if mode == "missing-created":
    toggle_states.remove("pressed")
summary_toggle = FakeNode("button", name="Toggle summary", geometry=(25, 0, 5, 5), states=toggle_states)
created_title = FakeNode("label", name=expected[1]["title"], geometry=(32, 8, 20, 4))
created_status_name = "Paused" if mode == "wrong-created-status" else "Working"
created_row_children = [created_title]
if mode != "missing-created-status":
    created_row_children.append(FakeNode("label", name=created_status_name, geometry=(53, 8, 8, 4)))
created_row = FakeNode("button", geometry=(31, 7, 35, 8), children=created_row_children)
created_header_states = {"showing", "visible", "expanded"}
if mode == "collapsed-created":
    created_header_states.remove("expanded")
created_children = [FakeNode("button", name="Created tasks (1)", geometry=(30, 1, 22, 5), states=created_header_states), created_row]
if mode == "show-more":
    created_children.append(FakeNode("button", name="Show 1 more…", geometry=(31, 18, 20, 5)))
created = FakeNode("presentation", geometry=(30, 0, 40, 30), children=created_children)

mcp_title = FakeNode("label", name=expected[2]["title"], geometry=(72, 8, 18, 4))
mcp_link_name = f"Open Codex task {thread_ids[2]}"
if mode == "missing-mcp-aria":
    mcp_link_name = ""
elif mode == "wrong-mcp-aria":
    mcp_link_name = "Open Codex task 01a01ae1-0000-7000-8000-999999999999"
mcp_link = FakeNode("link", name=mcp_link_name, geometry=(91, 8, 7, 4))
mcp_row = FakeNode("list item", geometry=(71, 7, 28, 8), children=(mcp_title, mcp_link))
mcp_geometry = (70, 0, 30, 30)
if mode == "aliased":
    mcp_geometry = created.geometry
mcp = FakeNode("group", name="Nelos task workers", geometry=mcp_geometry, children=(mcp_row,))

root_children = [sidebar, summary_toggle, created, mcp]
if mode == "duplicate-mcp":
    root_children.append(FakeNode("group", name="Nelos task workers", geometry=(70, 31, 30, 30)))
root = FakeNode("frame", name="Codex", geometry=(0, 0, 100, 80), children=root_children)

_scanned, proofs, _evidence = scope["classify_archive_surfaces"](root, expected)
sys.stdout.write(json.dumps({"proofs": proofs}, separators=(",", ":")))
