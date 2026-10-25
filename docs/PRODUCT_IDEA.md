# DevFlow — Product brief

## Problem
Developers repeatedly open terminals, navigate into frontend/backend folders, remember run commands, and juggle logs across several projects. Existing solutions (VS Code tasks, Docker Compose, Procfile tools) often require configuration or assume a specific workflow.

## Promise
**Select a project. Review detected services. Run everything. Read every log.**

## Target users
Solo full-stack developers and small teams working with multi-service local repositories, especially Windows users using Next.js + FastAPI or similar stacks.

## Core journey
1. Import project root.
2. Scan common manifests and folders.
3. Suggest executable, arguments, working directory.
4. Manually correct undetected services.
5. Save workspace and click Run all.
6. View logs by service or together; search/copy/export.
7. Stop or restart individual services.

## Differentiation hypothesis
Fewer setup steps than editor tasks or Compose for projects not already configured; unified logs and optional future MCP visibility. Validate through user testing, not assumption.

## Non-goals
Code editing, full Docker replacement, automatic cloud deployment, AI agent, universal zero-configuration support.

## Monetization hypothesis
Free local core; optional future paid team sync, shared templates, managed remote workspaces. Do not implement payment before validation.

## Validation
Test with 5–10 developers using unfamiliar repos. Measure import-to-first-successful-run time, detection correctness, orphan process rate, repeated weekly use, and willingness to recommend/pay.
