---
name: cleanup-feature-flag
description: Remove a stale GrowthBook feature flag from the codebase and keep only the winning code path. Use when the user asks to "clean up a feature flag", "remove a flag", "delete this feature flag", "ship the winning variant", "commit the feature flag", "graduate the flag", or "remove the old code path".
metadata:
  author: growthbook
  version: "1.0.0"
---

# Clean Up a Stale Feature Flag

Remove a feature flag that has been fully rolled out or abandoned, keeping only the winning code path and deleting the dead code.

## Step 1: Identify the Flag to Remove

Ask the user (if not already specified):
1. **Flag key** – the exact flag key used in the code (e.g., `new-checkout-flow`)
2. **Which value to keep** – "on" path (flag was fully rolled out) or "off" path (flag was abandoned)?

If the user is unsure, ask: "Is the feature being shipped to all users (keep the new code) or is it being reverted (keep the old code)?"

## Step 2: Find All Flag Usages

Search the codebase for every reference to the flag:

```bash
FLAG_KEY="new-checkout-flow"  # replace with the actual flag key

# Search across all source files
grep -r "$FLAG_KEY" \
  --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" \
  --include="*.py" --include="*.rb" \
  --include="*.go" --include="*.php" \
  --include="*.java" --include="*.kt" \
  -n 2>/dev/null
```

Also search for related patterns:
```bash
# Check for the flag key in config files
grep -r "$FLAG_KEY" \
  --include="*.json" --include="*.yaml" --include="*.yml" --include="*.env*" \
  -n 2>/dev/null | grep -v node_modules
```

List all files that need changes before making any edits.

## Step 3: Replace Flag Code with the Winning Path

For each usage found, replace the conditional flag code with only the winning path.

### React — `useFeatureIsOn` / `useFeatureValue` Hook

**Before (keeping the "on" path):**
```tsx
import { useFeatureIsOn } from "@growthbook/growthbook-react";

export function CheckoutPage() {
  const showNewCheckout = useFeatureIsOn("new-checkout-flow");
  return (
    <div>
      {showNewCheckout ? <NewCheckoutFlow /> : <LegacyCheckoutFlow />}
    </div>
  );
}
```

**After (new checkout won — ship it):**
```tsx
export function CheckoutPage() {
  return (
    <div>
      <NewCheckoutFlow />
    </div>
  );
}
```

**After (old checkout won — revert):**
```tsx
export function CheckoutPage() {
  return (
    <div>
      <LegacyCheckoutFlow />
    </div>
  );
}
```

### React — Value Flag

**Before:**
```tsx
const buttonColor = useFeatureValue("button-color", "blue");
```

**After (keep the value that won, e.g. "green"):**
```tsx
const buttonColor = "green";
```

### Vanilla JavaScript / TypeScript

**Before:**
```typescript
if (gb.isOn("new-metrics-panel")) {
  renderNewMetricsPanel();
} else {
  renderLegacyMetricsPanel();
}
```

**After (new panel won):**
```typescript
renderNewMetricsPanel();
```

**After (old panel won — revert):**
```typescript
renderLegacyMetricsPanel();
```

### Vanilla JavaScript / TypeScript — Value Flag

**Before:**
```typescript
const maxRetries = gb.getFeatureValue("max-retries", 3);
```

**After (hardcode the winning value, e.g. 5):**
```typescript
const maxRetries = 5;
```

### Next.js App Router (Server Component)

**Before:**
```typescript
export default async function Page() {
  const userId = (await cookies()).get("user-id")?.value ?? "anonymous";
  const gb = getServerGrowthBook(userId);
  await gb.loadFeatures();

  const showNewFeature = gb.isOn("new-feature");
  await gb.destroy();

  return showNewFeature ? <NewFeature /> : <LegacyFeature />;
}
```

**After (new feature won):**
```typescript
export default async function Page() {
  return <NewFeature />;
}
```

### Python

**Before:**
```python
if gb.is_on("new-payment-processor"):
    return new_payment_processor(order)
else:
    return legacy_payment_processor(order)
```

**After (new processor won):**
```python
return new_payment_processor(order)
```

### Ruby

**Before:**
```ruby
if gb.on?(:new_hero)
  render_new_hero
else
  render_legacy_hero
end
```

**After (new hero won):**
```ruby
render_new_hero
```

### Go

**Before:**
```go
if growthbook.Feature("new-request-handler").On {
  newHandler(w, r)
} else {
  legacyHandler(w, r)
}
```

**After (new handler won):**
```go
newHandler(w, r)
```

## Step 4: Remove Dead Code and Imports

After replacing all flag conditionals:

1. **Delete the losing code path** — remove the old function/component that is no longer used:
   ```bash
   # Search for the name of the losing component/function identified in Step 3
   # Replace <LosingSideIdentifier> with the actual function or component name
   grep -r "<LosingSideIdentifier>" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" -n 2>/dev/null
   ```

2. **Remove unused imports**:
   ```typescript
   // Remove these if no other flags are used in this file:
   import { useFeatureIsOn, useFeatureValue } from "@growthbook/growthbook-react";
   ```

3. **Check if GrowthBook is still used elsewhere** — if no more flags remain, consider removing the SDK entirely:
   ```bash
   grep -r "growthbook\|GrowthBook\|isOn\|getFeatureValue\|useFeatureIsOn\|useFeatureValue" \
     --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" \
     -l 2>/dev/null | grep -v node_modules
   ```
   If the SDK is no longer used anywhere, run:
   ```bash
   npm uninstall @growthbook/growthbook @growthbook/growthbook-react
   # or for Python:
   pip uninstall growthbook
   ```

4. **Clean up any feature flag setup files** if no more flags are in use:
   - Remove `src/lib/growthbook.ts` / `growthbook.py` initialization files
   - Remove the `<GrowthBookProvider>` wrapper from the app root

## Step 5: Archive the Flag in GrowthBook

After the code is cleaned up, archive or delete the flag in GrowthBook to keep the dashboard tidy:

1. Go to https://app.growthbook.io/features (or your self-hosted instance)
2. Find the feature flag by key (e.g., `new-checkout-flow`)
3. Click the flag → **Archive** (or **Delete** if it will never be needed again)

> **Tip:** Archive rather than delete if you want to keep the experiment results for historical analysis.

## Step 6: Verify the Cleanup

Run the test suite to confirm nothing broke:
```bash
npm test
# or
pytest
# or
go test ./...
# or
bundle exec rspec
```

Also manually test the affected functionality to confirm the winning path works correctly without the flag.

## Cleanup Checklist

- [ ] All usages of the flag key replaced with the winning code path
- [ ] Dead code (losing path components/functions) deleted
- [ ] Unused `useFeatureIsOn` / `useFeatureValue` / `isOn` / `getFeatureValue` imports removed
- [ ] GrowthBook SDK removed if no more flags remain
- [ ] Flag archived or deleted in the GrowthBook dashboard
- [ ] Tests pass
- [ ] Manually verified the winning behavior works as expected
