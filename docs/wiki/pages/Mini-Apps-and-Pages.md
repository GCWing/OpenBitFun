[English] | [简体中文](Mini-Apps-与-Pages) · [Home](Home)

# Mini Apps and Pages

## Mini Apps: installed tools with dedicated interfaces

A Mini App combines UI, persistent state, and an Agent workflow inside OpenBitFun. It can provide a repository dashboard, presentation workspace, form, tracker, or interactive explanation.

### Install and use

1. Open Mini Apps and browse the market or installed apps.
2. Read the listing, source, version, and requested permissions.
3. Install and open the app. Grant only the workspace/path access it needs.
4. Use its interface and dedicated conversation, where provided.

Market login, favorites, ratings, and updates are market-service features; they are distinct from local application use.

### Create and customize

Describe the tool you need, preferably in Creative. Ask the Agent to initialize, author, and validate it. Creation inside the installed client does not require editing OpenBitFun's source checkout.

For customization, open a draft, request changes, inspect the live preview and permission difference, then apply, synchronize, or discard the changes. Installed and draft state are separate. Review version history before rollback; do not assume a code rollback reverses every external effect.

Apps may use model calls and background Workers. Check Worker status and stop unnecessary work. Model calls may incur provider charges.

### Share an app

Market submission is an explicit publishing action, not part of merely creating an app. Review source, bundled data, permissions, and credentials before requesting submission; submissions go through market review.

## Pages: publish a versioned result

Pages is a service-backed publishing capability for static experiences. It differs from a Mini App installed inside your workspace.

1. Sign in with GitHub through the configured account service.
2. Save a page version and review its rendered content.
3. Choose the intended visibility/access settings and publish or deploy the selected version.
4. Open the share link and verify access.
5. Use versions to redeploy or roll back; unpublish when needed.

Unpublishing retains saved versions; deleting a version or Page is a separate action. Do not assume private content is safe to publish merely because the URL is hard to guess. Availability depends on the deployed service and the settings exposed by your version; historical Preview labels are not a service guarantee.

[Mini App market](https://market.openbitfun.com/miniapp/) · [Feature reference](https://github.com/GCWing/OpenBitFun/tree/v1.0.0/docs/interactive-capabilities/capabilities)

> Screenshot pending: S15 — market/app with conversation; S16 — draft and permissions; S17 — Pages versions and visibility.
