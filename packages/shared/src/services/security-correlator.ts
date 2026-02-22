/**
 * Real-Time Security Event Correlation
 *
 * Correlates security events from multiple sources to detect:
 * - Coordinated attacks
 * - Multi-stage intrusions
 * - Distributed threats
 * - Attack patterns across services
 *
 * Correlation Methods:
 * 1. Time-window correlation (events within time window)
 * 2. Pattern matching (known attack patterns)
 * 3. Graph-based correlation (relationship analysis)
 * 4. Behavioral clustering (similar behavior grouping)
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { EventEmitter } from 'events';

// ============================================================================
// SECURITY EVENT TYPES
// ============================================================================

export type SecurityEventType =
  | 'PROMPT_INJECTION_ATTEMPT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'ANOMALOUS_BEHAVIOR'
  | 'TOOL_EXECUTION_FAILURE'
  | 'AUTHENTICATION_FAILURE'
  | 'AUTHORIZATION_FAILURE'
  | 'DATA_ACCESS_VIOLATION'
  | 'INJECTION_ATTACK'
  | 'XSS_ATTEMPT'
  | 'CSRF_ATTEMPT'
  | 'BRUTE_FORCE'
  | 'PRIVILEGE_ESCALATION'
  | 'DATA_EXFILTRATION'
  | 'SUSPICIOUS_NETWORK_ACTIVITY';

export interface SecurityEvent {
  /** Unique event ID */
  id: string;
  /** Event type */
  type: SecurityEventType;
  /** Timestamp */
  timestamp: number;
  /** Source service */
  source: string;
  /** User ID (if available) */
  userId?: string;
  /** Session ID (if available) */
  sessionId?: string;
  /** IP address */
  ipAddress?: string;
  /** User agent */
  userAgent?: string;
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Event data */
  data: Record<string, unknown>;
  /** Related event IDs */
  relatedEventIds?: string[];
  /** Tags for correlation */
  tags?: string[];
}

// ============================================================================
// CORRELATED THREAT
// ============================================================================

export interface CorrelatedThreat {
  /** Threat ID */
  id: string;
  /** Threat type */
  type: ThreatType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Related events */
  events: SecurityEvent[];
  /** Affected users */
  affectedUsers: string[];
  /** Affected services */
  affectedServices: string[];
  /** Attack timeline */
  timeline: ThreatTimelineEntry[];
  /** Indicators of Compromise (IOCs) */
  ioCs: IndicatorOfCompromise[];
  /** Recommended actions */
  recommendedActions: string[];
  /** Status */
  status: 'detecting' | 'confirmed' | 'mitigating' | 'resolved' | 'false_positive';
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
}

export type ThreatType =
  | 'COORDINATED_ATTACK'
  | 'MULTI_STAGE_INTRUSION'
  | 'DISTRIBUTED_THREAT'
  | 'INSIDER_THREAT'
  | 'AUTOMATED_ATTACK'
  | 'CREDENTIAL_STUFFING'
  | 'DATA_BREACH';

export interface ThreatTimelineEntry {
  timestamp: number;
  eventType: SecurityEventType;
  description: string;
  severity: string;
}

export interface IndicatorOfCompromise {
  type: 'ip' | 'user_agent' | 'pattern' | 'behavior' | 'hash';
  value: string;
  confidence: number;
}

// ============================================================================
// CORRELATION ENGINE
// ============================================================================

export interface CorrelationEngineConfig {
  /** Time window for correlation in ms (default: 5 minutes) */
  timeWindowMs: number;
  /** Minimum events to form a threat (default: 3) */
  minEventsForThreat: number;
  /** Enable debug logging */
  debug: boolean;
  /** Known attack patterns */
  attackPatterns: AttackPattern[];
}

export interface AttackPattern {
  name: string;
  description: string;
  eventSequence: SecurityEventType[];
  maxTimeBetweenEventsMs: number;
  minConfidence: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

const DEFAULT_ATTACK_PATTERNS: AttackPattern[] = [
  {
    name: 'Credential Stuffing',
    description: 'Multiple authentication failures followed by success',
    eventSequence: ['AUTHENTICATION_FAILURE', 'AUTHENTICATION_FAILURE', 'AUTHENTICATION_FAILURE', 'AUTHENTICATION_FAILURE', 'AUTHENTICATION_FAILURE'],
    maxTimeBetweenEventsMs: 60000,
    minConfidence: 0.7,
    severity: 'high',
  },
  {
    name: 'Multi-Stage Intrusion',
    description: 'Reconnaissance followed by exploitation and data access',
    eventSequence: ['INJECTION_ATTACK', 'AUTHORIZATION_FAILURE', 'DATA_ACCESS_VIOLATION'],
    maxTimeBetweenEventsMs: 300000,
    minConfidence: 0.6,
    severity: 'critical',
  },
  {
    name: 'Prompt Injection Campaign',
    description: 'Coordinated prompt injection attempts from multiple sources',
    eventSequence: ['PROMPT_INJECTION_ATTEMPT', 'PROMPT_INJECTION_ATTEMPT', 'PROMPT_INJECTION_ATTEMPT'],
    maxTimeBetweenEventsMs: 120000,
    minConfidence: 0.8,
    severity: 'high',
  },
];

export class SecurityEventCorrelator extends EventEmitter {
  private config: CorrelationEngineConfig;
  private events: SecurityEvent[] = [];
  private threats: Map<string, CorrelatedThreat> = new Map();
  private eventIndex: Map<string, SecurityEvent> = new Map();
  private userEventIndex: Map<string, string[]> = new Map(); // userId -> eventIds
  private ipEventIndex: Map<string, string[]> = new Map(); // ipAddress -> eventIds

  constructor(config: Partial<CorrelationEngineConfig> = {}) {
    super();
    this.config = {
      timeWindowMs: 5 * 60 * 1000, // 5 minutes
      minEventsForThreat: 3,
      debug: false,
      attackPatterns: DEFAULT_ATTACK_PATTERNS,
      ...config,
    };
  }

  /**
   * Add a security event
   */
  async addEvent(event: Omit<SecurityEvent, 'id'>): Promise<SecurityEvent> {
    const completeEvent: SecurityEvent = {
      ...event,
      id: this.generateEventId(),
    };

    // Store event
    this.events.push(completeEvent);
    this.eventIndex.set(completeEvent.id, completeEvent);

    // Update indexes
    if (completeEvent.userId) {
      if (!this.userEventIndex.has(completeEvent.userId)) {
        this.userEventIndex.set(completeEvent.userId, []);
      }
      this.userEventIndex.get(completeEvent.userId)!.push(completeEvent.id);
    }

    if (completeEvent.ipAddress) {
      if (!this.ipEventIndex.has(completeEvent.ipAddress)) {
        this.ipEventIndex.set(completeEvent.ipAddress, []);
      }
      this.ipEventIndex.get(completeEvent.ipAddress)!.push(completeEvent.id);
    }

    // Cleanup old events
    this.cleanupOldEvents();

    // Check for correlations
    const correlatedThreats = await this.findCorrelations(completeEvent);

    // Emit events
    this.emit('event', completeEvent);
    
    for (const threat of correlatedThreats) {
      this.emit('threat_detected', threat);
    }

    if (this.config.debug) {
      console.log(`[SecurityCorrelator] Event added: ${completeEvent.type} from ${completeEvent.source}`);
    }

    return completeEvent;
  }

  /**
   * Find correlations for an event
   */
  private async findCorrelations(event: SecurityEvent): Promise<CorrelatedThreat[]> {
    const newThreats: CorrelatedThreat[] = [];

    // 1. Time-window correlation
    const timeWindowEvents = this.findEventsInTimeWindow(event);
    if (timeWindowEvents.length >= this.config.minEventsForThreat) {
      const threat = this.createTimeWindowThreat(timeWindowEvents);
      if (threat) {
        newThreats.push(threat);
      }
    }

    // 2. Pattern matching
    for (const pattern of this.config.attackPatterns) {
      const patternMatch = this.matchAttackPattern(event, pattern);
      if (patternMatch) {
        newThreats.push(patternMatch);
      }
    }

    // 3. IP-based correlation
    if (event.ipAddress) {
      const ipEvents = this.findEventsByIp(event.ipAddress);
      if (ipEvents.length >= this.config.minEventsForThreat) {
        const threat = this.createIpBasedThreat(ipEvents);
        if (threat) {
          newThreats.push(threat);
        }
      }
    }

    // 4. User-based correlation
    if (event.userId) {
      const userEvents = this.findEventsByUser(event.userId);
      if (userEvents.length >= this.config.minEventsForThreat) {
        const threat = this.createUserBasedThreat(userEvents);
        if (threat) {
          newThreats.push(threat);
        }
      }
    }

    // Store threats
    for (const threat of newThreats) {
      this.threats.set(threat.id, threat);
    }

    return newThreats;
  }

  /**
   * Find events within time window
   */
  private findEventsInTimeWindow(event: SecurityEvent): SecurityEvent[] {
    const windowStart = event.timestamp - this.config.timeWindowMs;
    const windowEnd = event.timestamp + this.config.timeWindowMs;

    return this.events.filter(e => 
      e.timestamp >= windowStart && 
      e.timestamp <= windowEnd &&
      e.id !== event.id &&
      this.isRelatedEvent(e, event)
    );
  }

  /**
   * Check if two events are related
   */
  private isRelatedEvent(a: SecurityEvent, b: SecurityEvent): boolean {
    // Same user
    if (a.userId && a.userId === b.userId) return true;
    
    // Same IP
    if (a.ipAddress && a.ipAddress === b.ipAddress) return true;
    
    // Same session
    if (a.sessionId && a.sessionId === b.sessionId) return true;
    
    // Related tags
    if (a.tags && b.tags) {
      const commonTags = a.tags.filter(t => b.tags?.includes(t));
      if (commonTags.length > 0) return true;
    }

    return false;
  }

  /**
   * Find events by IP address
   */
  private findEventsByIp(ipAddress: string): SecurityEvent[] {
    const eventIds = this.ipEventIndex.get(ipAddress) || [];
    return eventIds.map(id => this.eventIndex.get(id)).filter((e): e is SecurityEvent => e !== undefined);
  }

  /**
   * Find events by user ID
   */
  private findEventsByUser(userId: string): SecurityEvent[] {
    const eventIds = this.userEventIndex.get(userId) || [];
    return eventIds.map(id => this.eventIndex.get(id)).filter((e): e is SecurityEvent => e !== undefined);
  }

  /**
   * Match attack pattern
   */
  private matchAttackPattern(event: SecurityEvent, pattern: AttackPattern): CorrelatedThreat | null {
    // Find events that match the pattern sequence
    const matchingEvents: SecurityEvent[] = [event];

    // Look for preceding events in the pattern
    for (let i = pattern.eventSequence.length - 2; i >= 0; i--) {
      const expectedType = pattern.eventSequence[i];
      
      const precedingEvent = this.events.find(e =>
        e.type === expectedType &&
        e.timestamp < event.timestamp &&
        e.timestamp >= event.timestamp - pattern.maxTimeBetweenEventsMs &&
        this.isRelatedEvent(e, event)
      );

      if (precedingEvent) {
        matchingEvents.unshift(precedingEvent);
      } else {
        break;
      }
    }

    // Check if we matched enough of the pattern
    const matchRatio = matchingEvents.length / pattern.eventSequence.length;
    if (matchRatio >= pattern.minConfidence) {
      return this.createPatternMatchThreat(matchingEvents, pattern, matchRatio);
    }

    return null;
  }

  /**
   * Create time-window threat
   */
  private createTimeWindowThreat(events: SecurityEvent[]): CorrelatedThreat | null {
    if (events.length < this.config.minEventsForThreat) return null;

    const affectedUsers = [...new Set(events.filter(e => e.userId).map(e => e.userId!))];
    const affectedServices = [...new Set(events.map(e => e.source))];
    
    // Calculate severity based on event severities
    const severityScores = { low: 1, medium: 2, high: 3, critical: 4 };
    const avgSeverity = events.reduce((sum, e) => sum + severityScores[e.severity], 0) / events.length;
    
    const severity: CorrelatedThreat['severity'] = 
      avgSeverity >= 3.5 ? 'critical' :
      avgSeverity >= 2.5 ? 'high' :
      avgSeverity >= 1.5 ? 'medium' : 'low';

    return {
      id: this.generateThreatId(),
      type: 'COORDINATED_ATTACK',
      confidence: Math.min(1, events.length / 10),
      severity,
      events,
      affectedUsers,
      affectedServices,
      timeline: events.map(e => ({
        timestamp: e.timestamp,
        eventType: e.type,
        description: `${e.type} from ${e.source}`,
        severity: e.severity,
      })).sort((a, b) => a.timestamp - b.timestamp),
      ioCs: this.extractIOCs(events),
      recommendedActions: this.generateRecommendations(events),
      status: 'detecting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Create pattern match threat
   */
  private createPatternMatchThreat(
    events: SecurityEvent[],
    pattern: AttackPattern,
    confidence: number
  ): CorrelatedThreat {
    return {
      id: this.generateThreatId(),
      type: 'MULTI_STAGE_INTRUSION',
      confidence,
      severity: pattern.severity,
      events,
      affectedUsers: [...new Set(events.filter(e => e.userId).map(e => e.userId!))],
      affectedServices: [...new Set(events.map(e => e.source))],
      timeline: events.map(e => ({
        timestamp: e.timestamp,
        eventType: e.type,
        description: `${e.type} from ${e.source}`,
        severity: e.severity,
      })).sort((a, b) => a.timestamp - b.timestamp),
      ioCs: this.extractIOCs(events),
      recommendedActions: [
        `Investigate ${pattern.name} attack pattern`,
        'Review affected user accounts',
        'Check for data exfiltration',
      ],
      status: 'detecting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Create IP-based threat
   */
  private createIpBasedThreat(events: SecurityEvent[]): CorrelatedThreat | null {
    if (events.length < this.config.minEventsForThreat) return null;

    return {
      id: this.generateThreatId(),
      type: 'DISTRIBUTED_THREAT',
      confidence: Math.min(1, events.length / 5),
      severity: 'high',
      events,
      affectedUsers: [...new Set(events.filter(e => e.userId).map(e => e.userId!))],
      affectedServices: [...new Set(events.map(e => e.source))],
      timeline: events.map(e => ({
        timestamp: e.timestamp,
        eventType: e.type,
        description: `${e.type} from ${e.ipAddress}`,
        severity: e.severity,
      })).sort((a, b) => a.timestamp - b.timestamp),
      ioCs: events.filter(e => e.ipAddress).map(e => ({
        type: 'ip' as const,
        value: e.ipAddress!,
        confidence: 0.8,
      })),
      recommendedActions: [
        'Consider blocking suspicious IP addresses',
        'Implement rate limiting per IP',
        'Enable CAPTCHA for suspicious requests',
      ],
      status: 'detecting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Create user-based threat
   */
  private createUserBasedThreat(events: SecurityEvent[]): CorrelatedThreat | null {
    if (events.length < this.config.minEventsForThreat) return null;

    return {
      id: this.generateThreatId(),
      type: 'INSIDER_THREAT',
      confidence: Math.min(1, events.length / 5),
      severity: 'high',
      events,
      affectedUsers: [...new Set(events.filter(e => e.userId).map(e => e.userId!))],
      affectedServices: [...new Set(events.map(e => e.source))],
      timeline: events.map(e => ({
        timestamp: e.timestamp,
        eventType: e.type,
        description: `${e.type} by user ${e.userId}`,
        severity: e.severity,
      })).sort((a, b) => a.timestamp - b.timestamp),
      ioCs: this.extractIOCs(events),
      recommendedActions: [
        'Review user account activity',
        'Check for compromised credentials',
        'Consider temporary account suspension',
      ],
      status: 'detecting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Extract IOCs from events
   */
  private extractIOCs(events: SecurityEvent[]): IndicatorOfCompromise[] {
    const ioCs: IndicatorOfCompromise[] = [];

    for (const event of events) {
      if (event.ipAddress) {
        ioCs.push({
          type: 'ip',
          value: event.ipAddress,
          confidence: 0.7,
        });
      }
      if (event.userAgent) {
        ioCs.push({
          type: 'user_agent',
          value: event.userAgent,
          confidence: 0.6,
        });
      }
    }

    return ioCs;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(events: SecurityEvent[]): string[] {
    const recommendations = new Set<string>();

    const eventTypes = new Set(events.map(e => e.type));

    if (eventTypes.has('PROMPT_INJECTION_ATTEMPT')) {
      recommendations.add('Review and enhance prompt injection detection');
    }
    if (eventTypes.has('RATE_LIMIT_EXCEEDED')) {
      recommendations.add('Consider adjusting rate limits');
    }
    if (eventTypes.has('AUTHENTICATION_FAILURE')) {
      recommendations.add('Enable multi-factor authentication');
    }
    if (eventTypes.has('DATA_ACCESS_VIOLATION')) {
      recommendations.add('Review data access policies');
    }

    recommendations.add('Investigate correlated security events');
    recommendations.add('Update security monitoring rules');

    return Array.from(recommendations);
  }

  /**
   * Cleanup old events
   */
  private cleanupOldEvents(): void {
    const cutoff = Date.now() - (60 * 60 * 1000); // 1 hour
    this.events = this.events.filter(e => e.timestamp > cutoff);
    
    // Cleanup indexes
    for (const [eventId, event] of this.eventIndex.entries()) {
      if (event.timestamp <= cutoff) {
        this.eventIndex.delete(eventId);
      }
    }
  }

  /**
   * Get threat by ID
   */
  getThreat(threatId: string): CorrelatedThreat | null {
    return this.threats.get(threatId) || null;
  }

  /**
   * Get all active threats
   */
  getActiveThreats(): CorrelatedThreat[] {
    return Array.from(this.threats.values()).filter(t => t.status !== 'resolved' && t.status !== 'false_positive');
  }

  /**
   * Update threat status
   */
  updateThreatStatus(threatId: string, status: CorrelatedThreat['status']): void {
    const threat = this.threats.get(threatId);
    if (threat) {
      threat.status = status;
      threat.updatedAt = Date.now();
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalEvents: number;
    totalThreats: number;
    activeThreats: number;
    eventsByType: Record<string, number>;
    threatsBySeverity: Record<string, number>;
  } {
    const eventsByType: Record<string, number> = {};
    for (const event of this.events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    }

    const threatsBySeverity: Record<string, number> = {};
    for (const threat of this.threats.values()) {
      threatsBySeverity[threat.severity] = (threatsBySeverity[threat.severity] || 0) + 1;
    }

    return {
      totalEvents: this.events.length,
      totalThreats: this.threats.size,
      activeThreats: this.getActiveThreats().length,
      eventsByType,
      threatsBySeverity,
    };
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateThreatId(): string {
    return `threat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSecurityEventCorrelator(config?: Partial<CorrelationEngineConfig>): SecurityEventCorrelator {
  return new SecurityEventCorrelator(config);
}
