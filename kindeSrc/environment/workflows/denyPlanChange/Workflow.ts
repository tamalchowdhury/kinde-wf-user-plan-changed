// Workflow.ts
import {
  onPlanSelection,
  WorkflowSettings,
  WorkflowTrigger,
  denyPlanSelection,
  fetch,
} from "@kinde/infrastructure"

// --- Settings: enable the bindings we use ---
export const workflowSettings: WorkflowSettings = {
  id: "onUserPlanSelection",
  name: "Deny Plan Change (dynamic limits)",
  trigger: WorkflowTrigger.PlanSelection,
  failurePolicy: { action: "stop" },
  bindings: {
    "kinde.plan": {},
    "kinde.fetch": {}, // call Kinde Management API
    "kinde.secureFetch": {}, // call YOUR API securely
    url: {},
  },
}

// --- Customize this to your feature key in Kinde ---
const FEATURE_KEY = "tracked_accounts"

// Treat 2147483647 and null/maxless as "unlimited"
const isUnlimited = (v: unknown) => v == null || Number(v) === 2147483647

// Pull the billing customer id for the requesting user
async function getBillingCustomerId(userId: string) {
  const qs = new URLSearchParams({ id: userId, expand: "billing" })
  const res = await fetch(`/api/v1/user?${qs.toString()}`, {
    method: "GET",
    responseFormat: "json",
    headers: { "Content-Type": "application/json" },
  })
  const user = res.json
  return user?.billing?.customer_id as string | undefined
}

// Fetch all entitlements for the billing customer, with per-plan data
async function getCustomerEntitlements(customerId: string) {
  const qs = new URLSearchParams({
    customer_id: customerId,
    expand: "plans",
    // If an entitlement has no max set, ask Kinde to return this fallback number:
    // (lets us treat "null" as a concrete number, which we then map to unlimited)
    max_value: String(2147483647),
  })
  const res = await fetch(`/api/v1/billing/entitlements?${qs.toString()}`, {
    method: "GET",
    responseFormat: "json",
    headers: { "Content-Type": "application/json" },
  })
  return res.json?.entitlements ?? []
}

// Find the limit for a given feature *on the requested plan*.
// Falls back to the entitlement’s top-level max if per-plan info isn’t present.
function limitForPlan(
  entitlements: any[],
  featureKey: string,
  requestedPlanCode: string
): number {
  const ent = entitlements.find(
    (e: any) => e.feature_key === featureKey || e.feature_code === featureKey // handle either naming in responses
  )
  if (!ent) return 0

  // Prefer per-plan expansion if present
  const planEntry =
    ent.plans?.find(
      (p: any) =>
        p.plan_code === requestedPlanCode ||
        p.key === requestedPlanCode ||
        p.code === requestedPlanCode
    ) ?? null

  const rawMax =
    planEntry?.entitlement_limit_max ??
    ent.entitlement_limit_max ??
    ent.max ?? // be defensive about schema variations
    null

  return isUnlimited(rawMax) ? 2147483647 : Number(rawMax)
}

// Ask YOUR API for the organization’s live usage (members, projects, etc.)
async function getUsageData(kindeId: string) {
  // Implement this endpoint in your app; example shown below.
  try {
    const res = await kinde.fetch(
      `http://your-api.com/api/users/${kindeId}/accounts/count`,
      {
        method: "GET",
        responseFormat: "json",
        headers: { "Content-Type": "application/json" },
      }
    )
    // Expect shape like: { kindeId: string, count: number }
    const data = await res.json()
    return data
  } catch (error) {
    return null
  }
}

// Main workflow: compare current usage to requested plan limits
export default async function Workflow(event: onPlanSelection) {
  const requestedPlanCode = event.context.billing.requestedPlanCode
  const orgCode = event.context.organization?.code
  const userId = event.context.user?.id

  // Sanity: we need user and org to proceed
  if (!userId || !orgCode || !requestedPlanCode) {
    // If something’s missing, let the selection proceed (or choose to deny).
    console.log("Something is missing, reqturning")
    console.log(
      `userId: ${userId} orgCode: ${orgCode} requestedPlanCode: ${requestedPlanCode}`
    )

    return
  }

  // 1) Identify the billing customer
  const customerId = await getBillingCustomerId(userId)
  if (!customerId) {
    denyPlanSelection(
      "We couldn’t verify your billing profile. Please try again."
    )
    return
  }

  // 2) Read entitlements from Kinde (with per-plan expansion)
  const entitlements = await getCustomerEntitlements(customerId)

  // 3) Read live usage from your app
  const usage = await getUsageData(userId)

  // 4) Compare usage vs limits for each feature you care about
  const failReasons: string[] = []

  // Tracked accounts

  // if (limit !== "unlimited" && limit !== undefined) {
  //   const used = Number(usage.count ?? 0)
  //   if (used > limit) {
  //     failReasons.push(
  //       `Delete tracked accounts to ${limit} or fewer (currently ${used}).`
  //     )
  //   }
  // }

  // Add additional feature checks here as needed...
  // e.g. “accounts”, “environments”, “workspaces”, etc.

  // Get the limit
  const requestedPlanLimit = limitForPlan(
    entitlements,
    FEATURE_KEY,
    requestedPlanCode
  )

  // Get the usage
  // TODO: to be added
  const currentUsage = 3

  // log for debugging:
  console.log("Requested plan limit", requestedPlanLimit)

  // Check if eligible
  const isEligibleForPlanChange = currentUsage <= requestedPlanLimit

  if (!isEligibleForPlanChange) {
    denyPlanSelection("To move from Pro to the Free plan you first need to:", [
      `Delete tracked accounts to ${requestedPlanLimit} or fewer (currently ${currentUsage}).`,
    ])
  }
}
