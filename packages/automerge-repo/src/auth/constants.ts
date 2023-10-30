import { SharePolicy, ValidAuthenticationResult } from "./types.js"

// CONSTANTS

export const AUTHENTICATION_VALID: ValidAuthenticationResult = { isValid: true }

export const ALWAYS_OK: SharePolicy = async () => true
export const NEVER_OK: SharePolicy = async () => false
