# nummioX UI polish — confirmation flows and responsive layout

## Scope
This milestone follows the household collaboration branch and is limited to the client presentation layer.

## Requirements and acceptance criteria
- UI-001: Replace native browser confirm dialogs for destructive actions with one consistent, localized in-app dialog.
- UI-002: Replace native browser prompt dialogs used for payment/receipt amounts, savings contributions and renaming with a styled in-app input dialog.
- UI-003: Preserve cancel behavior: cancelling must never send a mutation request.
- UI-004: Preserve existing amount validation and API payloads for received income, paid obligations and savings contributions.
- UI-005: Confirm all delete/archive/revoke actions, including budgets, savings goals and pending household invitations.
- UI-006: Dialogs must support keyboard submission, Escape cancellation, accessible dialog semantics and mobile safe-area spacing.
- UI-007: Prevent nested cards, forms, filters, long labels and calendar cells from forcing horizontal viewport overflow.
- UI-008: Keep Russian and English copy consistent with the existing language setting.

## Implementation notes
- Shared dialog state and resolver live in PersonalFinanceApp; dialog styling is scoped under pf-dialog classes.
- Existing API endpoints, payloads, validation rules and finance calculations remain unchanged.
- Responsive containment rules are additive and retain the current visual theme.

## Verification
- Static source scan: no remaining window.alert, window.confirm or window.prompt calls.
- CI must pass TypeScript/Vite build and existing server/client tests before staging deployment.
- The stacked pull-request target branch is included in the CI pull_request filter so checks run before review.

- Manual staging QA should cover 320px, 360px, 390px, 768px and desktop widths; test every destructive action's cancel/confirm path and amount-entry validation.
- Stage 9 responsive pass: long currency values and labels wrap within their cards; dialog content remains scrollable on short-height screens; the calendar keeps seven bounded columns.


## Responsive audit — next staging pass
- [ ] Test 320px, 360px, 390px, 768px and 1024px widths with Russian and English labels.
- [ ] At tablet widths, move to the compact top navigation and stack two-column pages instead of squeezing desktop columns.
- [ ] Verify all nine navigation targets are visible and have at least 44px touch targets on compact phones.
- [ ] Check long amounts, long category/member names, filters, inline forms, alerts and action buttons for clipping or horizontal overflow.
- [ ] Verify calendar seven-column layout, receipt scanner controls and dialog scrolling on short screens.
- [ ] Confirm keyboard focus and reduced-motion behavior after responsive changes.
