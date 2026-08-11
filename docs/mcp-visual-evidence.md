# MCP visual evidence

These screenshots were captured from the production MCP Apps resources in the
official reference host through optional maintainer-only infrastructure. Access
to the visual runner is not required to build, test, or contribute to Nelos.
Each capture uses the final source tree, reaches `Tool Result`, and reports no
browser console errors. The public fixture and host contracts are checked in and
covered by the repository test suite.

## Single running worker

A lone worker renders directly. Its status is an attribute of the worker rather
than an expandable hierarchy level.

![Single running worker](assets/mcp-visuals/single-running-worker.png)

## Authorization required

Multiple workers that need input share one purposeful disclosure group. Exact
statuses remain visible on the worker rows.

![Authorization-required workers](assets/mcp-visuals/authorization-required-workers.png)

## Archiving spin-off

The direct row preserves the parent task, lifecycle, model, reasoning, native
task identity, and active status without adding a generic status container.

![Archiving spin-off](assets/mcp-visuals/archiving-spinoff.png)

## Mixed current work

Large maps default to the relevant `Current` view. `Needs input` opens
automatically, while `In progress` and `Queued` remain compact. Terminal and
archived workers are available through the count-bearing `Done` and `History`
filters.

![Mixed current work](assets/mcp-visuals/mixed-current-filter.png)

## Larger history

Current and historical workers remain one click apart without presenting every
raw status as a navigation category.

![Current and historical workers](assets/mcp-visuals/large-history-filter.png)

## Plan summary

Planning tools use a dedicated compact summary rather than an execution-state
placeholder.

![Plan summary](assets/mcp-visuals/plan-summary.png)

## Accepted action receipt

Outcome tools use a concise receipt that labels the affected work unit.

![Accepted action receipt](assets/mcp-visuals/accepted-action-receipt.png)
