---
name: install-growthbook-sdk
description: Install and integrate the GrowthBook SDK into an app. Use when the user asks to "add GrowthBook", "set up feature flags with GrowthBook", "integrate GrowthBook SDK", "add GrowthBook to my project", or "configure GrowthBook".
metadata:
  author: growthbook
  version: "1.0.0"
---

# Install and Integrate the GrowthBook SDK

Set up the GrowthBook SDK in any application to enable feature flagging and A/B testing.

## Step 1: Detect the Project Type

Examine the project to determine the language and framework:

```bash
# Check for package.json (Node.js / JavaScript / TypeScript)
cat package.json 2>/dev/null

# Check for requirements.txt / pyproject.toml (Python)
cat requirements.txt 2>/dev/null || cat pyproject.toml 2>/dev/null

# Check for go.mod (Go)
cat go.mod 2>/dev/null

# Check for Gemfile (Ruby)
cat Gemfile 2>/dev/null
```

Look for framework indicators: `react`, `next`, `vue`, `svelte`, `express`, `fastapi`, `django`, `rails`, etc.

## Step 2: Install the SDK

### JavaScript / TypeScript (Vanilla)
```bash
npm install @growthbook/growthbook
# or
yarn add @growthbook/growthbook
# or
pnpm add @growthbook/growthbook
```

### React / Next.js
```bash
npm install @growthbook/growthbook-react
```

### Python
```bash
pip install growthbook
```

### Ruby
```bash
gem install growthbook
# or add to Gemfile:
# gem 'growthbook'
```

### Go
```bash
go get github.com/growthbook/growthbook-golang
```

### PHP
```bash
composer require growthbook/growthbook
```

## Step 3: Ask for GrowthBook Connection Details

If the user has not provided them, ask for:
1. **Client Key** – Found in GrowthBook under **Settings → API Keys** (starts with `sdk-`)
2. **API Host** – Defaults to `https://cdn.growthbook.io`; may be a custom self-hosted URL
3. **Streaming / SSE** – Optional; enables real-time feature flag updates

If the user does not have these yet, instruct them to:
1. Create a free account at https://app.growthbook.io
2. Navigate to **Settings → API Keys** and create a new SDK Connection
3. Copy the **Client Key** shown (starts with `sdk-`)

## Step 4: Initialize and Configure

### React (recommended: Context Provider pattern)

Create `src/lib/growthbook.ts` (or `.js`):
```typescript
import { GrowthBook } from "@growthbook/growthbook-react";

export const gb = new GrowthBook({
  apiHost: "https://cdn.growthbook.io",
  clientKey: "sdk-YOUR_CLIENT_KEY",
  enableDevMode: process.env.NODE_ENV !== "production",
  trackingCallback: (experiment, result) => {
    // TODO: send to your analytics (e.g. Segment, Mixpanel, PostHog)
    console.log("Viewed Experiment", {
      experimentId: experiment.key,
      variationId: result.key,
    });
  },
});
```

Wrap your app in `src/main.tsx` (Vite) or `pages/_app.tsx` (Next.js):
```tsx
import { GrowthBookProvider } from "@growthbook/growthbook-react";
import { gb } from "./lib/growthbook";
import { useEffect } from "react";

function App() {
  useEffect(() => {
    // Load feature flags from the GrowthBook API
    gb.loadFeatures({ autoRefresh: true });
  }, []);

  // Set user attributes for targeting (call again when user logs in/out)
  gb.setAttributes({
    id: "user-123",          // required for consistent bucketing
    // Add other attributes for targeting rules:
    // email: user.email,
    // plan: user.plan,
    // country: user.country,
  });

  return (
    <GrowthBookProvider growthbook={gb}>
      {/* your app */}
    </GrowthBookProvider>
  );
}
```

### Next.js App Router

Create `lib/growthbook.ts`:
```typescript
import { GrowthBook } from "@growthbook/growthbook";

export function getServerGrowthBook(userId?: string) {
  const gb = new GrowthBook({
    apiHost: "https://cdn.growthbook.io",
    clientKey: "sdk-YOUR_CLIENT_KEY",
  });
  if (userId) {
    gb.setAttributes({ id: userId });
  }
  return gb;
}
```

Use in a Server Component:
```typescript
import { getServerGrowthBook } from "@/lib/growthbook";

export default async function Page() {
  const gb = getServerGrowthBook("user-123");
  await gb.loadFeatures();

  const showBanner = gb.isOn("my-banner-feature");
  await gb.destroy();

  return <div>{showBanner && <Banner />}</div>;
}
```

### Vanilla JavaScript / TypeScript

```typescript
import { GrowthBook } from "@growthbook/growthbook";

const gb = new GrowthBook({
  apiHost: "https://cdn.growthbook.io",
  clientKey: "sdk-YOUR_CLIENT_KEY",
  attributes: {
    id: "user-123",
  },
});

// Load features before evaluating flags
await gb.loadFeatures();

// Evaluate feature flags
if (gb.isOn("dark-mode")) {
  document.body.classList.add("dark");
}

const checkoutVariant = gb.getFeatureValue("checkout-variant", "control");
```

### Python

```python
from growthbook import GrowthBook
import requests

# Fetch features from GrowthBook CDN
features_url = "https://cdn.growthbook.io/api/features/sdk-YOUR_CLIENT_KEY"
features = requests.get(features_url).json().get("features", {})

gb = GrowthBook(
    api_host="https://cdn.growthbook.io",  # Python uses snake_case; JS/TS uses camelCase (apiHost, clientKey)
    client_key="sdk-YOUR_CLIENT_KEY",
    attributes={
        "id": "user-123",
        # Add targeting attributes:
        # "plan": user.plan,
        # "country": request.country,
    },
    features=features,
    tracking_callback=lambda experiment, result: print(
        f"Experiment viewed: {experiment.key} = {result.key}"
    ),
)

# Evaluate flags
if gb.is_on("dark-mode"):
    enable_dark_mode()

checkout_variant = gb.get_feature_value("checkout-variant", "control")
```

### Ruby

```ruby
require "growthbook"
require "net/http"
require "json"

# Fetch features
uri = URI("https://cdn.growthbook.io/api/features/sdk-YOUR_CLIENT_KEY")
features = JSON.parse(Net::HTTP.get(uri))["features"]

gb = Growthbook::Context.new(
  attributes: { id: "user-123" },
  features: features
)

# Evaluate flags
if gb.on?(:dark_mode)
  enable_dark_mode
end
```

### Go

```go
package main

import (
  "context"
  "encoding/json"
  "net/http"

  gb "github.com/growthbook/growthbook-golang"
)

func main() {
  // Fetch features from GrowthBook CDN
  resp, _ := http.Get("https://cdn.growthbook.io/api/features/sdk-YOUR_CLIENT_KEY")
  var featuresResponse struct {
    Features gb.FeatureMap `json:"features"`
  }
  json.NewDecoder(resp.Body).Decode(&featuresResponse)

  growthbook := gb.New(context.Background(), &gb.Options{
    ClientKey: "sdk-YOUR_CLIENT_KEY",
    Attributes: gb.Attributes{
      "id": "user-123",
    },
  })
  growthbook.WithFeatures(featuresResponse.Features)

  // Evaluate flags
  if growthbook.Feature("dark-mode").On {
    enableDarkMode()
  }
}
```

## Step 5: Store the Client Key Securely

- **Never** hardcode the client key directly in source files committed to git
- Use environment variables:
  - `.env`: `GROWTHBOOK_CLIENT_KEY=sdk-YOUR_CLIENT_KEY`
  - Reference as `process.env.GROWTHBOOK_CLIENT_KEY` (Node.js) or `os.environ["GROWTHBOOK_CLIENT_KEY"]` (Python)
- For browser/frontend apps, the SDK client key is public-facing (read-only) and is safe to expose; only server-side secret keys need protection

## Step 6: Verify the Integration

After setup, verify it works:
1. Open your GrowthBook dashboard and create a test feature flag (e.g., `test-flag`)
2. Enable the flag for all users
3. In your code, check `gb.isOn("test-flag")` and log the result
4. Confirm you see `true` in the output

## Common Issues

| Issue | Solution |
|-------|----------|
| Features always return default value | Ensure `loadFeatures()` / `await gb.loadFeatures()` completes before evaluating flags |
| Targeting rules not matching | Check that `setAttributes()` includes the correct attribute keys used in your targeting rules |
| CORS errors in browser | Verify the API host URL is correct; GrowthBook CDN allows CORS by default |
| Old feature values cached | Call `gb.refreshFeatures()` or use `autoRefresh: true` |

## Next Steps

- Create feature flags in GrowthBook UI at https://app.growthbook.io/features
- Use the **wrap-feature-flag** skill to wrap existing code in a feature flag
- Set up user attributes for targeting (device type, plan, location, etc.)
- Add an analytics callback to track experiment exposures
