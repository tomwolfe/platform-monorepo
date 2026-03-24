/**
 * Security Audit Checklist
 *
 * Comprehensive security checklist for production deployment.
 * Use this to verify all security measures are in place.
 *
 * @see Phase 1.4: Security Hardening
 */

// ============================================================================
// SECURITY AUDIT CHECKLIST
// ============================================================================

export interface SecurityAuditItem {
  /** Unique identifier for the check */
  id: string;
  /** Category of the check */
  category: SecurityCategory;
  /** Description of what to check */
  description: string;
  /** Why this check is important */
  rationale: string;
  /** How to verify/fix */
  verification: string;
  /** OWASP reference if applicable */
  owasp?: string;
  /** Priority level */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Status */
  status?: 'pass' | 'fail' | 'not-applicable' | 'pending';
  /** Notes */
  notes?: string;
}

export type SecurityCategory =
  | 'authentication'
  | 'authorization'
  | 'input-validation'
  | 'data-protection'
  | 'session-management'
  | 'access-control'
  | 'logging-monitoring'
  | 'configuration'
  | 'infrastructure'
  | 'dependencies';

/**
 * Complete security audit checklist
 */
export const SECURITY_AUDIT_CHECKLIST: SecurityAuditItem[] = [
  // ============================================================================
  // AUTHENTICATION
  // ============================================================================
  {
    id: 'AUTH-001',
    category: 'authentication',
    description: 'Verify JWT tokens are properly validated',
    rationale: 'Invalid token validation can lead to unauthorized access',
    verification: 'Check that all JWT verification uses verifyAsymmetricJWT or verifyServiceToken with proper audience/issuer validation',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'critical',
  },
  {
    id: 'AUTH-002',
    category: 'authentication',
    description: 'Verify token expiration is enforced',
    rationale: 'Expired tokens should not be accepted',
    verification: 'Check JWT verification includes exp claim validation',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'critical',
  },
  {
    id: 'AUTH-003',
    category: 'authentication',
    description: 'Verify CSRF protection is enabled for state-changing operations',
    rationale: 'CSRF attacks can trick users into performing unintended actions',
    verification: 'Check withSecurityMiddleware includes csrf: { enabled: true } for POST/PUT/DELETE endpoints',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'critical',
  },
  {
    id: 'AUTH-004',
    category: 'authentication',
    description: 'Verify API keys are stored securely',
    rationale: 'Exposed API keys can lead to unauthorized access',
    verification: 'Check API keys are in environment variables, not in code or logs',
    owasp: 'A07:2021-Identification and Authentication Failures',
    priority: 'high',
  },

  // ============================================================================
  // AUTHORIZATION
  // ============================================================================
  {
    id: 'AUTHZ-001',
    category: 'authorization',
    description: 'Verify restaurant access control is enforced',
    rationale: 'Users should only access their own restaurant data',
    verification: 'Check all restaurant queries include restaurantId validation against authenticated user',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'critical',
  },
  {
    id: 'AUTHZ-002',
    category: 'authorization',
    description: 'Verify admin endpoints require admin role',
    rationale: 'Privilege escalation can lead to unauthorized admin access',
    verification: 'Check admin endpoints verify user role claims',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'critical',
  },

  // ============================================================================
  // INPUT VALIDATION
  // ============================================================================
  {
    id: 'INPUT-001',
    category: 'input-validation',
    description: 'Verify all API inputs are validated with Zod schemas',
    rationale: 'Unvalidated input can lead to injection attacks',
    verification: 'Check all API routes use validateRequest with appropriate schema',
    owasp: 'A03:2021-Injection',
    priority: 'critical',
  },
  {
    id: 'INPUT-002',
    category: 'input-validation',
    description: 'Verify input sanitization is enabled for user-generated content',
    rationale: 'XSS attacks can occur through unsanitized user input',
    verification: 'Check withSecurityMiddleware includes inputSanitization: { enabled: true, stripHtml: true }',
    owasp: 'A03:2021-Injection',
    priority: 'high',
  },
  {
    id: 'INPUT-003',
    category: 'input-validation',
    description: 'Verify SQL injection prevention',
    rationale: 'SQL injection can lead to data breach',
    verification: 'Check all database queries use parameterized queries (Drizzle ORM)',
    owasp: 'A03:2021-Injection',
    priority: 'critical',
  },
  {
    id: 'INPUT-004',
    category: 'input-validation',
    description: 'Verify file upload validation',
    rationale: 'Malicious file uploads can compromise server',
    verification: 'Check file uploads validate type, size, and scan for malware',
    owasp: 'A03:2021-Injection',
    priority: 'high',
  },

  // ============================================================================
  // DATA PROTECTION
  // ============================================================================
  {
    id: 'DATA-001',
    category: 'data-protection',
    description: 'Verify sensitive data is encrypted at rest',
    rationale: 'Data breach impact is reduced with encryption',
    verification: 'Check database encryption is enabled for sensitive fields',
    owasp: 'A02:2021-Cryptographic Failures',
    priority: 'high',
  },
  {
    id: 'DATA-002',
    category: 'data-protection',
    description: 'Verify HTTPS is enforced',
    rationale: 'Unencrypted traffic can be intercepted',
    verification: 'Check HSTS header is set and HTTP redirects to HTTPS',
    owasp: 'A02:2021-Cryptographic Failures',
    priority: 'critical',
  },
  {
    id: 'DATA-003',
    category: 'data-protection',
    description: 'Verify PII is not logged',
    rationale: 'PII in logs can lead to data breach',
    verification: 'Check logs do not contain emails, passwords, tokens, or payment info',
    owasp: 'A02:2021-Cryptographic Failures',
    priority: 'high',
  },

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================
  {
    id: 'SESSION-001',
    category: 'session-management',
    description: 'Verify session tokens are rotated',
    rationale: 'Session fixation attacks use static tokens',
    verification: 'Check tokens are regenerated after authentication',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'medium',
  },
  {
    id: 'SESSION-002',
    category: 'session-management',
    description: 'Verify session timeout is configured',
    rationale: 'Long-lived sessions increase hijacking risk',
    verification: 'Check JWT exp claim is set appropriately (e.g., 1 hour)',
    owasp: 'A01:2021-Broken Access Control',
    priority: 'medium',
  },

  // ============================================================================
  // ACCESS CONTROL
  // ============================================================================
  {
    id: 'ACCESS-001',
    category: 'access-control',
    description: 'Verify rate limiting is enabled on all endpoints',
    rationale: 'Rate limiting prevents DoS and brute force attacks',
    verification: 'Check withSecurityMiddleware includes rateLimit: { enabled: true }',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'high',
  },
  {
    id: 'ACCESS-002',
    category: 'access-control',
    description: 'Verify CORS is properly configured',
    rationale: 'Overly permissive CORS can lead to data theft',
    verification: 'Check CORS origins are restricted to known domains',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'high',
  },
  {
    id: 'ACCESS-003',
    category: 'access-control',
    description: 'Verify security headers are set',
    rationale: 'Security headers prevent common attacks',
    verification: 'Check withSecurityMiddleware includes securityHeaders: { enabled: true }',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'high',
  },

  // ============================================================================
  // LOGGING & MONITORING
  // ============================================================================
  {
    id: 'LOG-001',
    category: 'logging-monitoring',
    description: 'Verify authentication failures are logged',
    rationale: 'Failed auth attempts can indicate attacks',
    verification: 'Check logger.warn is called for auth failures',
    owasp: 'A09:2021-Security Logging and Monitoring Failures',
    priority: 'high',
  },
  {
    id: 'LOG-002',
    category: 'logging-monitoring',
    description: 'Verify rate limit events are logged',
    rationale: 'Rate limiting indicates potential attacks',
    verification: 'Check rate limit middleware logs exceeded events',
    owasp: 'A09:2021-Security Logging and Monitoring Failures',
    priority: 'medium',
  },
  {
    id: 'LOG-003',
    category: 'logging-monitoring',
    description: 'Verify error messages do not leak sensitive info',
    rationale: 'Detailed errors can aid attackers',
    verification: 'Check production errors use generic messages',
    owasp: 'A09:2021-Security Logging and Monitoring Failures',
    priority: 'high',
  },
  {
    id: 'LOG-004',
    category: 'logging-monitoring',
    description: 'Verify Sentry error tracking is configured',
    rationale: 'Error tracking helps identify security issues',
    verification: 'Check initSentry is called with proper DSN',
    owasp: 'A09:2021-Security Logging and Monitoring Failures',
    priority: 'medium',
  },

  // ============================================================================
  // CONFIGURATION
  // ============================================================================
  {
    id: 'CONFIG-001',
    category: 'configuration',
    description: 'Verify debug mode is disabled in production',
    rationale: 'Debug mode can leak sensitive information',
    verification: 'Check NODE_ENV=production disables stack traces',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'high',
  },
  {
    id: 'CONFIG-002',
    category: 'configuration',
    description: 'Verify secrets are not in version control',
    rationale: 'Exposed secrets can lead to breaches',
    verification: 'Check .env files are in .gitignore',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'critical',
  },
  {
    id: 'CONFIG-003',
    category: 'configuration',
    description: 'Verify default credentials are changed',
    rationale: 'Default credentials are well-known',
    verification: 'Check all default passwords/keys are replaced',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'critical',
  },

  // ============================================================================
  // INFRASTRUCTURE
  // ============================================================================
  {
    id: 'INFRA-001',
    category: 'infrastructure',
    description: 'Verify database is not publicly accessible',
    rationale: 'Public database access can lead to data breach',
    verification: 'Check database is in private network/VPC',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'critical',
  },
  {
    id: 'INFRA-002',
    category: 'infrastructure',
    description: 'Verify firewall rules are restrictive',
    rationale: 'Open ports increase attack surface',
    verification: 'Check only required ports (80, 443) are open',
    owasp: 'A05:2021-Security Misconfiguration',
    priority: 'high',
  },

  // ============================================================================
  // DEPENDENCIES
  // ============================================================================
  {
    id: 'DEP-001',
    category: 'dependencies',
    description: 'Verify dependencies are up to date',
    rationale: 'Outdated dependencies may have known vulnerabilities',
    verification: 'Run npm audit and pnpm audit regularly',
    owasp: 'A06:2021-Vulnerable and Outdated Components',
    priority: 'high',
  },
  {
    id: 'DEP-002',
    category: 'dependencies',
    description: 'Verify no known vulnerable packages',
    rationale: 'Known vulnerabilities can be exploited',
    verification: 'Check Snyk/GitHub Dependabot reports',
    owasp: 'A06:2021-Vulnerable and Outdated Components',
    priority: 'high',
  },
];

// ============================================================================
// AUDIT UTILITIES
// ============================================================================

/**
 * Run security audit
 */
export function runSecurityAudit(
  checklist: SecurityAuditItem[] = SECURITY_AUDIT_CHECKLIST
): SecurityAuditReport {
  const results = checklist.map(item => ({
    ...item,
    status: item.status || 'pending',
  }));

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const pending = results.filter(r => r.status === 'pending').length;
  const notApplicable = results.filter(r => r.status === 'not-applicable').length;

  const score = passed / (passed + failed) * 100;

  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      pending,
      notApplicable,
      score: Math.round(score),
    },
    timestamp: new Date().toISOString(),
  };
}

export interface SecurityAuditReport {
  results: SecurityAuditItem[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    notApplicable: number;
    score: number;
  };
  timestamp: string;
}

/**
 * Get critical items that must pass
 */
export function getCriticalItems(
  checklist: SecurityAuditItem[] = SECURITY_AUDIT_CHECKLIST
): SecurityAuditItem[] {
  return checklist.filter(item => item.priority === 'critical');
}

/**
 * Get items by category
 */
export function getItemsByCategory(
  category: SecurityCategory,
  checklist: SecurityAuditItem[] = SECURITY_AUDIT_CHECKLIST
): SecurityAuditItem[] {
  return checklist.filter(item => item.category === category);
}

/**
 * Get failed items
 */
export function getFailedItems(
  report: SecurityAuditReport
): SecurityAuditItem[] {
  return report.results.filter(item => item.status === 'fail');
}

/**
 * Get OWASP mapping
 */
export function getOWASPMapping(
  checklist: SecurityAuditItem[] = SECURITY_AUDIT_CHECKLIST
): Record<string, SecurityAuditItem[]> {
  const mapping: Record<string, SecurityAuditItem[]> = {};

  for (const item of checklist) {
    if (item.owasp) {
      if (!mapping[item.owasp]) {
        mapping[item.owasp] = [];
      }
      mapping[item.owasp].push(item);
    }
  }

  return mapping;
}

// Type re-exports only (values are already exported inline)
export type {
  SecurityAuditItem,
  SecurityCategory,
  SecurityAuditReport,
};
