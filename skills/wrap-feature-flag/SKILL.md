---
name: wrap-feature-flag
description: Wrap existing code in a GrowthBook feature flag. Use when the user asks to "add a feature flag", "put this behind a flag", "gate this feature", "wrap this in a feature flag", "make this configurable with a feature flag", or "add an experiment".
metadata:
  author: growthbook
  version: "1.0.0"
---

# Wrap Code in a Feature Flag

Take existing code and conditionally execute it based on a GrowthBook feature flag, allowing remote control of features without redeploying.

## Step 1: Identify the Code to Flag

Ask the user (if not already specified):
1. **What code** should be gated? (e.g., a UI component, a function, a service call)
2. **What should the flag be named?** Suggest a lowercase kebab-case name like `new-checkout-flow` or `dark-mode`
3. **What is the default behavior** when the flag is off? (show old code, show nothing, etc.)
4. **What type of flag is this?**
   - Boolean on/off toggle (most common)
   - String/number value (e.g., button color, price multiplier)
   - JSON object (e.g., configuration block)

## Step 2: Detect the GrowthBook Setup

Check for an existing GrowthBook integration:

```bash
# Look for existing GrowthBook imports
grep -r "growthbook\|GrowthBook" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go" -l 2>/dev/null | head -10

# Look for initialization file
find . -name "growthbook*" -not -path "*/node_modules/*" 2>/dev/null
```

If no integration exists, use the **install-growthbook-sdk** skill first.

## Step 3: Wrap the Code

### React — Boolean Flag (show/hide a component)

**Before:**
```tsx
export function CheckoutPage() {
  return (
    <div>
      <NewCheckoutFlow />
    </div>
  );
}
```

**After:**
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

### React — String/Number Value Flag

**Before:**
```tsx
const buttonColor = "blue";
```

**After:**
```tsx
import { useFeatureValue } from "@growthbook/growthbook-react";

const buttonColor = useFeatureValue("button-color", "blue"); // "blue" is the default
```

### React — Multivariate / JSON Flag

```tsx
import { useFeatureValue } from "@growthbook/growthbook-react";

interface BannerConfig {
  title: string;
  cta: string;
  variant: "primary" | "secondary";
}

const bannerConfig = useFeatureValue<BannerConfig>("hero-banner", {
  title: "Welcome",
  cta: "Get Started",
  variant: "primary",
});
```

### Vanilla JavaScript / TypeScript — Boolean Flag

**Before:**
```typescript
function renderDashboard() {
  renderNewMetricsPanel();
}
```

**After:**
```typescript
import { gb } from "./lib/growthbook"; // your GrowthBook instance

function renderDashboard() {
  if (gb.isOn("new-metrics-panel")) {
    renderNewMetricsPanel();
  } else {
    renderLegacyMetricsPanel();
  }
}
```

### Vanilla JavaScript / TypeScript — Value Flag

**Before:**
```typescript
const maxRetries = 3;
```

**After:**
```typescript
import { gb } from "./lib/growthbook";

const maxRetries = gb.getFeatureValue("max-retries", 3);
```

### Next.js App Router (Server Component) — Boolean Flag

**Before:**
```typescript
export default async function Page() {
  return <NewFeature />;
}
```

**After:**
```typescript
import { getServerGrowthBook } from "@/lib/growthbook";
import { cookies } from "next/headers";

export default async function Page() {
  // Get user ID from session/cookie for consistent bucketing
  const userId = (await cookies()).get("user-id")?.value ?? "anonymous";
  const gb = getServerGrowthBook(userId);
  await gb.loadFeatures();

  const showNewFeature = gb.isOn("new-feature");
  await gb.destroy();

  return showNewFeature ? <NewFeature /> : <LegacyFeature />;
}
```

### Python — Boolean Flag

**Before:**
```python
def process_payment(order):
    return legacy_payment_processor(order)
```

**After:**
```python
def process_payment(order, user_id: str):
    gb = get_growthbook_client(user_id)  # your GrowthBook factory

    if gb.is_on("new-payment-processor"):
        return new_payment_processor(order)
    else:
        return legacy_payment_processor(order)
```

### Python — Value Flag

**Before:**
```python
timeout_seconds = 30
```

**After:**
```python
timeout_seconds = gb.get_feature_value("api-timeout-seconds", 30)
```

### Ruby — Boolean Flag

**Before:**
```ruby
def render_hero
  render_new_hero
end
```

**After:**
```ruby
def render_hero
  if gb.on?(:new_hero)
    render_new_hero
  else
    render_legacy_hero
  end
end
```

### Go — Boolean Flag

**Before:**
```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
  newHandler(w, r)
}
```

**After:**
```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
  growthbook := getGrowthBookForRequest(r) // your factory
  if growthbook.Feature("new-request-handler").On {
    newHandler(w, r)
  } else {
    legacyHandler(w, r)
  }
}
```

## Step 4: Create the Feature Flag in GrowthBook

After adding the flag to the code, remind the user to create the feature flag in GrowthBook:

1. Go to https://app.growthbook.io/features (or your self-hosted instance)
2. Click **Add Feature**
3. Set:
   - **Key**: Use the exact same key used in code (e.g., `new-checkout-flow`)
   - **Type**: Boolean, String, Number, or JSON
   - **Default Value**: The fallback when no rules match
4. Add targeting rules or override rules as needed
5. To enable for all users: add a **Force Value** rule with 100% coverage

## Step 5: Verify the Flag Works

Test both flag states:

```typescript
// Temporarily test flag on
gb.setAttributes({ id: "test-user" });
// Then check that the flagged feature renders correctly

// Temporarily test flag off (use a different user ID not in the test group)
// OR use GrowthBook's override rules in the dashboard
```

## Flag Naming Conventions

| Pattern | Example | Use case |
|---------|---------|----------|
| `feature-name` | `new-checkout` | Feature toggles |
| `exp-feature-name` | `exp-checkout-v2` | A/B experiments |
| `config-setting` | `config-max-items` | Remote config values |
| `kill-switch-service` | `kill-switch-payments` | Emergency kill switches |

## Best Practices

- **Always provide a default value** that represents the current/safe behavior
- **Use `isOn()` for boolean flags** and `getFeatureValue()` for string/number/JSON values
- **Set user attributes before evaluating flags** to ensure consistent targeting
- **Document the flag** with a clear description in GrowthBook noting what it controls
- **Plan the cleanup** — when the rollout is complete, use the **cleanup-feature-flag** skill to remove the flag code
