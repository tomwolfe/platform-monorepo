/**
 * MCP Tool Security Scanner
 *
 * Scans dynamically discovered MCP tools for security risks before registration.
 * Detects potentially dangerous patterns in tool definitions and implementations.
 *
 * Security Checks:
 * 1. Environment variable access patterns
 * 2. File system access
 * 3. Network request capabilities
 * 4. Code execution patterns (eval, Function, etc.)
 * 5. Prototype pollution vectors
 * 6. Command injection patterns
 * 7. Path traversal patterns
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from 'zod';

// ============================================================================
// SECURITY SCAN RESULT
// ============================================================================

export interface SecurityScanResult {
  /** Whether the tool passed all security checks */
  isSafe: boolean;
  /** Risk level */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Security issues found */
  issues: SecurityIssue[];
  /** Recommendations */
  recommendations: string[];
  /** Whether tool should be blocked */
  shouldBlock: boolean;
}

export interface SecurityIssue {
  /** Issue type */
  type: SecurityIssueType;
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Description of the issue */
  description: string;
  /** Location in code (if available) */
  location?: string;
  /** Pattern that matched */
  matchedPattern?: string;
  /** Suggested remediation */
  remediation?: string;
}

export type SecurityIssueType =
  | 'ENV_ACCESS'
  | 'FILE_SYSTEM_ACCESS'
  | 'NETWORK_ACCESS'
  | 'CODE_EXECUTION'
  | 'PROTOTYPE_POLLUTION'
  | 'COMMAND_INJECTION'
  | 'PATH_TRAVERSAL'
  | 'DANGEROUS_GLOBAL'
  | 'UNSAFE_REGEX'
  | 'SQL_INJECTION'
  | 'SSRF_VULNERABILITY';

// ============================================================================
// SECURITY PATTERNS
// ============================================================================

const DANGEROUS_PATTERNS: Array<{
  type: SecurityIssueType;
  pattern: RegExp;
  severity: SecurityIssue['severity'];
  description: string;
  remediation: string;
}> = [
  // Code execution
  {
    type: 'CODE_EXECUTION',
    pattern: /\b(eval|Function|setTimeout|setInterval)\s*\(/g,
    severity: 'critical',
    description: 'Direct code execution detected',
    remediation: 'Remove eval/Function calls. Use safe alternatives.',
  },
  {
    type: 'CODE_EXECUTION',
    pattern: /\bnew\s+Function\s*\(/g,
    severity: 'critical',
    description: 'Dynamic function creation detected',
    remediation: 'Avoid creating functions from strings.',
  },
  
  // Environment access
  {
    type: 'ENV_ACCESS',
    pattern: /process\.env/g,
    severity: 'high',
    description: 'Environment variable access detected',
    remediation: 'Use dependency injection for configuration.',
  },
  {
    type: 'ENV_ACCESS',
    pattern: /\bgetenv\b|\bgetEnv\b/g,
    severity: 'high',
    description: 'Environment variable retrieval detected',
    remediation: 'Use dependency injection for configuration.',
  },
  
  // File system access
  {
    type: 'FILE_SYSTEM_ACCESS',
    pattern: /\b(fs|path|file)\.(readFile|writeFile|appendFile|unlink|rm|mkdir|readdir|stat)\b/g,
    severity: 'high',
    description: 'File system operation detected',
    remediation: 'Restrict file operations to sandboxed directories.',
  },
  {
    type: 'FILE_SYSTEM_ACCESS',
    pattern: /__dirname|__filename/g,
    severity: 'medium',
    description: 'Directory/filename reference detected',
    remediation: 'Avoid using absolute paths.',
  },
  
  // Command injection
  {
    type: 'COMMAND_INJECTION',
    pattern: /\b(child_process|exec|spawn|execSync|spawnSync)\b/g,
    severity: 'critical',
    description: 'Shell command execution detected',
    remediation: 'Use safe APIs instead of shell commands.',
  },
  {
    type: 'COMMAND_INJECTION',
    pattern: /\$\{[^}]*\$\([^)]*\)/g,
    severity: 'critical',
    description: 'Command substitution in string detected',
    remediation: 'Never interpolate command output in strings.',
  },
  
  // Path traversal
  {
    type: 'PATH_TRAVERSAL',
    pattern: /\.\.[\\/]/g,
    severity: 'high',
    description: 'Path traversal pattern detected',
    remediation: 'Validate and sanitize file paths.',
  },
  
  // Prototype pollution
  {
    type: 'PROTOTYPE_POLLUTION',
    pattern: /\.__proto__\s*=/g,
    severity: 'critical',
    description: 'Prototype modification detected',
    remediation: 'Never modify Object.prototype.',
  },
  {
    type: 'PROTOTYPE_POLLUTION',
    pattern: /constructor\.(prototype|__proto__)\s*=/g,
    severity: 'critical',
    description: 'Constructor prototype modification detected',
    remediation: 'Never modify constructor prototypes.',
  },
  {
    type: 'PROTOTYPE_POLLUTION',
    pattern: /Object\.(defineProperty|setPrototypeOf|assign)\s*\(\s*Object\.prototype/g,
    severity: 'critical',
    description: 'Object.prototype modification detected',
    remediation: 'Never modify Object.prototype.',
  },
  
  // Network access (SSRF)
  {
    type: 'SSRF_VULNERABILITY',
    pattern: /\b(http|https|net|dgram)\.(get|request|connect|createConnection)\b/g,
    severity: 'medium',
    description: 'Network request capability detected',
    remediation: 'Validate URLs and restrict internal network access.',
  },
  {
    type: 'SSRF_VULNERABILITY',
    pattern: /127\.0\.0\.1|localhost|0\.0\.0\.0/g,
    severity: 'medium',
    description: 'Internal network address detected',
    remediation: 'Block internal network addresses.',
  },
  
  // SQL injection
  {
    type: 'SQL_INJECTION',
    pattern: /\$\{[^}]*\}/g,
    severity: 'medium',
    description: 'String interpolation detected (potential SQL injection)',
    remediation: 'Use parameterized queries.',
  },
  
  // Unsafe regex
  {
    type: 'UNSAFE_REGEX',
    pattern: /\^?(\.[*+])+\$?/g,
    severity: 'low',
    description: 'Potentially unsafe regex pattern',
    remediation: 'Review regex for ReDoS vulnerability.',
  },
];

// ============================================================================
// MCP TOOL SECURITY SCANNER
// ============================================================================

export interface MCPServerDefinition {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    implementation?: string; // Tool implementation code
  }>;
}

export class MCPToolSecurityScanner {
  private config: {
    /** Block tools with critical issues (default: true) */
    blockCritical: boolean;
    /** Block tools with high severity issues (default: false) */
    blockHigh: boolean;
    /** Allow specific patterns (whitelist) */
    allowedPatterns: string[];
    /** Deny specific patterns (blacklist) */
    deniedPatterns: string[];
  };

  constructor(config?: Partial<typeof MCPToolSecurityScanner.prototype.config>) {
    this.config = {
      blockCritical: true,
      blockHigh: false,
      allowedPatterns: [],
      deniedPatterns: [],
      ...config,
    };
  }

  /**
   * Scan an MCP server definition for security issues
   */
  scanServer(server: MCPServerDefinition): SecurityScanResult {
    const issues: SecurityIssue[] = [];
    
    // Scan server configuration
    if (server.command) {
      issues.push({
        type: 'COMMAND_INJECTION',
        severity: 'medium',
        description: 'Server executes external command',
        location: 'server.command',
        matchedPattern: server.command,
        remediation: 'Ensure command is from trusted source.',
      });
    }

    // Scan environment variables
    if (server.env) {
      const sensitiveVars = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'CREDENTIAL'];
      for (const [key, value] of Object.entries(server.env)) {
        if (sensitiveVars.some(s => key.toUpperCase().includes(s))) {
          issues.push({
            type: 'ENV_ACCESS',
            severity: 'low',
            description: `Sensitive environment variable exposed: ${key}`,
            location: `server.env.${key}`,
            remediation: 'Use secrets management for sensitive values.',
          });
        }
      }
    }

    // Scan tool implementations
    if (server.tools) {
      for (const tool of server.tools) {
        if (tool.implementation) {
          const toolIssues = this.scanCode(tool.implementation, tool.name);
          issues.push(...toolIssues);
        }
        
        // Scan tool input schema for dangerous patterns
        if (tool.inputSchema) {
          const schemaIssues = this.scanInputSchema(tool.inputSchema, tool.name);
          issues.push(...schemaIssues);
        }
      }
    }

    return this.buildResult(issues);
  }

  /**
   * Scan tool implementation code
   */
  scanCode(code: string, toolName?: string): SecurityIssue[] {
    const issues: SecurityIssue[] = [];

    for (const { type, pattern, severity, description, remediation } of DANGEROUS_PATTERNS) {
      // Reset regex lastIndex
      pattern.lastIndex = 0;
      
      const matches = code.match(pattern);
      if (matches) {
        issues.push({
          type,
          severity,
          description: `${description}${toolName ? ` in tool: ${toolName}` : ''}`,
          location: toolName,
          matchedPattern: matches[0],
          remediation,
        });
      }
    }

    // Check for denied patterns
    for (const deniedPattern of this.config.deniedPatterns) {
      const regex = new RegExp(deniedPattern, 'g');
      const matches = code.match(regex);
      if (matches) {
        issues.push({
          type: 'COMMAND_INJECTION',
          severity: 'high',
          description: `Blacklisted pattern detected${toolName ? ` in tool: ${toolName}` : ''}`,
          location: toolName,
          matchedPattern: matches[0],
          remediation: 'Remove blacklisted pattern.',
        });
      }
    }

    return issues;
  }

  /**
   * Scan tool input schema for injection vectors
   */
  scanInputSchema(schema: Record<string, unknown>, toolName?: string): SecurityIssue[] {
    const issues: SecurityIssue[] = [];
    
    // Check for shell metacharacters in default values
    const shellMetacharacters = /[;&|`$(){}[\]<>\\]/;
    
    const checkValue = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (shellMetacharacters.test(value)) {
          issues.push({
            type: 'COMMAND_INJECTION',
            severity: 'medium',
            description: `Shell metacharacter in default value${toolName ? ` for ${toolName}.${path}` : ''}`,
            location: toolName,
            matchedPattern: value,
            remediation: 'Remove shell metacharacters from default values.',
          });
        }
      }
      
      if (typeof value === 'object' && value !== null) {
        for (const [key, val] of Object.entries(value)) {
          checkValue(val, `${path}.${key}`);
        }
      }
    };
    
    checkValue(schema, 'schema');
    
    return issues;
  }

  /**
   * Build scan result with recommendations
   */
  private buildResult(issues: SecurityIssue[]): SecurityScanResult {
    const criticalIssues = issues.filter(i => i.severity === 'critical');
    const highIssues = issues.filter(i => i.severity === 'high');
    const mediumIssues = issues.filter(i => i.severity === 'medium');
    const lowIssues = issues.filter(i => i.severity === 'low');

    // Determine risk level
    let riskLevel: SecurityScanResult['riskLevel'] = 'low';
    if (criticalIssues.length > 0) riskLevel = 'critical';
    else if (highIssues.length > 0) riskLevel = 'high';
    else if (mediumIssues.length > 0) riskLevel = 'medium';

    // Determine if should block
    const shouldBlock = 
      (criticalIssues.length > 0 && this.config.blockCritical) ||
      (highIssues.length > 0 && this.config.blockHigh);

    // Generate recommendations
    const recommendations = this.generateRecommendations(issues);

    return {
      isSafe: !shouldBlock,
      riskLevel,
      issues,
      recommendations,
      shouldBlock,
    };
  }

  /**
   * Generate recommendations based on issues
   */
  private generateRecommendations(issues: SecurityIssue[]): string[] {
    const recommendations = new Set<string>();

    for (const issue of issues) {
      if (issue.remediation) {
        recommendations.add(issue.remediation);
      }
    }

    // Add general recommendations based on issue types
    const issueTypes = new Set(issues.map(i => i.type));

    if (issueTypes.has('ENV_ACCESS')) {
      recommendations.add('Consider using a secrets manager for sensitive configuration.');
    }

    if (issueTypes.has('FILE_SYSTEM_ACCESS')) {
      recommendations.add('Implement path validation and sandboxing for file operations.');
    }

    if (issueTypes.has('NETWORK_ACCESS') || issueTypes.has('SSRF_VULNERABILITY')) {
      recommendations.add('Implement URL allowlisting and block internal network access.');
    }

    if (issueTypes.has('CODE_EXECUTION')) {
      recommendations.add('CRITICAL: Remove all dynamic code execution. This is a severe security risk.');
    }

    return Array.from(recommendations);
  }

  /**
   * Get summary of scan results
   */
  getSummary(result: SecurityScanResult): string {
    const parts: string[] = [];

    parts.push(`Risk Level: ${result.riskLevel.toUpperCase()}`);
    parts.push(`Status: ${result.isSafe ? '✅ PASS' : '❌ FAIL'}`);
    
    if (result.issues.length > 0) {
      const bySeverity = {
        critical: result.issues.filter(i => i.severity === 'critical').length,
        high: result.issues.filter(i => i.severity === 'high').length,
        medium: result.issues.filter(i => i.severity === 'medium').length,
        low: result.issues.filter(i => i.severity === 'low').length,
      };

      parts.push(`Issues: ${bySeverity.critical} critical, ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low`);
    }

    return parts.join(' | ');
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createMCPToolSecurityScanner(config?: Partial<ConstructorParameters<typeof MCPToolSecurityScanner>[0]>): MCPToolSecurityScanner {
  return new MCPToolSecurityScanner(config);
}
