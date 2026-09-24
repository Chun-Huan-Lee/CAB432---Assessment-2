/**
 * Cognito Pre Sign-up trigger: only QUT email addresses may register, and
 * those accounts are auto-confirmed (the student role cannot call the Admin*
 * Cognito APIs in the shared account).
 */
import type { PreSignUpTriggerEvent } from "aws-lambda";

const ALLOWED = [/@qut\.edu\.au$/i, /@connect\.qut\.edu\.au$/i];

export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  const email = event.request.userAttributes.email ?? "";
  if (!ALLOWED.some((pattern) => pattern.test(email))) {
    throw new Error("Only QUT email addresses can register.");
  }
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
}
