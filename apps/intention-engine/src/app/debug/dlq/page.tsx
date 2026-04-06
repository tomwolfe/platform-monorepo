'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui-theme/components/ui/table';
import { Button } from '@repo/ui-theme/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@repo/ui-theme/components/ui/dialog';
import { Input } from '@repo/ui-theme/components/ui/input';
import { Label } from '@repo/ui-theme/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui-theme/components/ui/card';
import { cn } from '@repo/ui-theme/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface DLQSaga {
  executionId: string;
  workflowId: string;
  intentId?: string;
  userId?: string;
  status: string;
  lastActivityAt: string;
  inactiveDurationMs: number;
  inactiveDurationHuman: string;
  stepStates: Array<{
    step_id: string;
    status: string;
    toolName?: string;
    error?: any;
  }>;
  compensationsRegistered?: Array<{
    stepId: string;
    compensationTool: string;
    parameters: Record<string, unknown>;
  }>;
  requiresHumanIntervention: boolean;
  recoveryAttempts: number;
  failureReason?: string;
  trace?: any;
  snapshots?: any[];
}

interface DLQResponse {
  sagas: DLQSaga[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

interface SagaDetailResponse {
  saga: DLQSaga;
}

// ============================================================================
// API HELPERS
// ============================================================================

async function fetchDLQSagas(filters: {
  status?: string;
  minInactiveMinutes?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
} = {}): Promise<DLQResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.minInactiveMinutes) params.set('minInactiveMinutes', filters.minInactiveMinutes);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  if (filters.sortBy) params.set('sortBy', filters.sortBy);
  if (filters.sortOrder) params.set('sortOrder', filters.sortOrder);

  const res = await fetch(`/api/dlq/sagas?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch DLQ sagas');
  return res.json();
}

async function fetchSagaDetail(executionId: string): Promise<SagaDetailResponse> {
  const res = await fetch(`/api/dlq/sagas/${executionId}`);
  if (!res.ok) throw new Error('Failed to fetch saga detail');
  return res.json();
}

async function resumeSaga(executionId: string, body: {
  fixedParameters?: Record<string, unknown>;
  skipSteps?: string[];
  resumeFromStep?: string;
  reason: string;
  adminUserId: string;
}): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`/api/dlq/sagas/${executionId}?action=resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to resume saga');
  }
  return res.json();
}

async function cancelSaga(executionId: string, body: {
  reason: string;
  adminUserId: string;
  attemptCompensation?: boolean;
}): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`/api/dlq/sagas/${executionId}?action=cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to cancel saga');
  }
  return res.json();
}

// ============================================================================
// STATUS BADGE
// ============================================================================

function StatusBadge({ status, requiresHumanIntervention }: { status: string; requiresHumanIntervention: boolean }) {
  const color = requiresHumanIntervention
    ? 'bg-red-100 text-red-800 border-red-200'
    : status === 'failed'
    ? 'bg-orange-100 text-orange-800 border-orange-200'
    : 'bg-yellow-100 text-yellow-800 border-yellow-200';

  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold', color)}>
      {requiresHumanIntervention ? 'Manual Intervention' : status}
    </span>
  );
}

// ============================================================================
// SAGA DETAIL DRAWER
// ============================================================================

function SagaDetailDialog({
  saga,
  open,
  onOpenChange,
  onActionComplete,
}: {
  saga: DLQSaga | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActionComplete: () => void;
}) {
  const [action, setAction] = useState<'resume' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [fixedParamsJson, setFixedParamsJson] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async () => {
    if (!saga) return;
    setLoading(true);
    setError(null);

    try {
      if (action === 'resume') {
        let fixedParameters: Record<string, unknown> | undefined;
        if (fixedParamsJson.trim()) {
          try {
            fixedParameters = JSON.parse(fixedParamsJson);
          } catch {
            setError('Invalid JSON in fixed parameters');
            setLoading(false);
            return;
          }
        }

        await resumeSaga(saga.executionId, {
          fixedParameters,
          reason: reason || `Manually resumed by admin - ${new Date().toISOString()}`,
          adminUserId: 'admin-ui',
        });
      } else if (action === 'cancel') {
        await cancelSaga(saga.executionId, {
          reason: reason || `Manually cancelled by admin - ${new Date().toISOString()}`,
          adminUserId: 'admin-ui',
          attemptCompensation: true,
        });
      }

      setAction(null);
      setReason('');
      setFixedParamsJson('');
      onActionComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setLoading(false);
    }
  };

  if (!saga) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Saga Details</DialogTitle>
          <DialogDescription>
            Execution ID: <code className="text-xs bg-muted px-1 py-0.5 rounded">{saga.executionId}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Overview */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Status:</span>
              <div className="mt-1">
                <StatusBadge status={saga.status} requiresHumanIntervention={saga.requiresHumanIntervention} />
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Inactive Duration:</span>
              <div className="font-medium">{saga.inactiveDurationHuman}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Recovery Attempts:</span>
              <div className="font-medium">{saga.recoveryAttempts}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Last Activity:</span>
              <div className="font-medium">{new Date(saga.lastActivityAt).toLocaleString()}</div>
            </div>
          </div>

          {/* Failure Reason */}
          {saga.failureReason && (
            <div>
              <span className="text-muted-foreground text-sm">Failure Reason:</span>
              <pre className="mt-1 text-xs bg-red-50 border border-red-200 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all">
                {typeof saga.failureReason === 'string' ? saga.failureReason : JSON.stringify(saga.failureReason, null, 2)}
              </pre>
            </div>
          )}

          {/* Step States */}
          <div>
            <h4 className="text-sm font-semibold mb-2">Step States</h4>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Step ID</TableHead>
                    <TableHead>Tool</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {saga.stepStates?.map((step) => (
                    <TableRow key={step.step_id}>
                      <TableCell className="font-mono text-xs">{step.step_id.slice(0, 8)}...</TableCell>
                      <TableCell className="text-sm">{step.toolName || '-'}</TableCell>
                      <TableCell>
                        <span className={cn(
                          'text-xs font-medium px-2 py-0.5 rounded',
                          step.status === 'completed' ? 'bg-green-100 text-green-800' :
                          step.status === 'failed' ? 'bg-red-100 text-red-800' :
                          step.status === 'compensated' ? 'bg-orange-100 text-orange-800' :
                          'bg-gray-100 text-gray-800'
                        )}>
                          {step.status}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Trace Data */}
          {saga.trace && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Execution Trace</h4>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-40">
                {typeof saga.trace === 'string' ? saga.trace : JSON.stringify(saga.trace, null, 2)}
              </pre>
            </div>
          )}

          {/* Action Forms */}
          {action && (
            <div className="border rounded-lg p-4 space-y-4 bg-slate-50">
              <h4 className="text-sm font-semibold">
                {action === 'resume' ? 'Resume Saga' : 'Cancel Saga'}
              </h4>

              <div className="space-y-2">
                <Label htmlFor="reason">Reason (required, min 10 chars)</Label>
                <Input
                  id="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Describe why you are taking this action..."
                />
              </div>

              {action === 'resume' && (
                <div className="space-y-2">
                  <Label htmlFor="fixedParams">Fixed Parameters (JSON, optional)</Label>
                  <textarea
                    id="fixedParams"
                    value={fixedParamsJson}
                    onChange={(e) => setFixedParamsJson(e.target.value)}
                    placeholder='{"key": "value"}'
                    className="w-full min-h-[100px] rounded-md border bg-background px-3 py-2 text-sm font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Override failed step parameters. Leave empty to retry with original values.
                  </p>
                </div>
              )}

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</p>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={handleAction}
                  disabled={loading || reason.length < 10}
                  variant={action === 'cancel' ? 'destructive' : 'default'}
                >
                  {loading ? 'Processing...' : action === 'resume' ? 'Resume Saga' : 'Cancel Saga'}
                </Button>
                <Button variant="outline" onClick={() => { setAction(null); setError(null); setReason(''); setFixedParamsJson(''); }}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {!action && (
            <div className="flex gap-2 w-full">
              <Button
                variant="default"
                onClick={() => setAction('resume')}
                disabled={loading}
              >
                Resume Saga
              </Button>
              <Button
                variant="destructive"
                onClick={() => setAction('cancel')}
                disabled={loading}
              >
                Cancel Saga
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export default function DLQDashboardPage() {
  const [sagas, setSagas] = useState<DLQSaga[]>([]);
  const [pagination, setPagination] = useState<DLQResponse['pagination'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSaga, setSelectedSaga] = useState<DLQSaga | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filters, setFilters] = useState({
    status: 'all',
    sortBy: 'inactiveDuration',
    sortOrder: 'desc' as 'asc' | 'desc',
  });

  const loadSagas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDLQSagas({
        ...filters,
        limit: 50,
        offset: 0,
      });
      setSagas(data.sagas);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DLQ sagas');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadSagas();
  }, [loadSagas]);

  const handleInspect = async (saga: DLQSaga) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setSelectedSaga(saga);
    try {
      const data = await fetchSagaDetail(saga.executionId);
      setSelectedSaga(data.saga);
    } catch (err) {
      console.error('Failed to load saga detail:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">DLQ Recovery Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Monitor and recover stuck sagas in the Dead Letter Queue.
        </p>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 flex-wrap items-end">
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                value={filters.status}
                onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
                className="flex h-10 w-[180px] rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="all">All</option>
                <option value="recoverable">Recoverable</option>
                <option value="manual_intervention">Manual Intervention</option>
                <option value="auto_recovered">Auto Recovered</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sortBy">Sort By</Label>
              <select
                id="sortBy"
                value={filters.sortBy}
                onChange={(e) => setFilters(prev => ({ ...prev, sortBy: e.target.value }))}
                className="flex h-10 w-[180px] rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="inactiveDuration">Inactive Duration</option>
                <option value="recoveryAttempts">Recovery Attempts</option>
                <option value="lastActivity">Last Activity</option>
              </select>
            </div>
            <Button onClick={loadSagas} variant="outline">
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-red-800">
          {error}
        </div>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading DLQ sagas...
            </div>
          ) : sagas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <p className="text-lg font-medium">No sagas in DLQ</p>
              <p className="text-sm">All sagas are processing normally.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Execution ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Inactive Duration</TableHead>
                  <TableHead>Recovery Attempts</TableHead>
                  <TableHead>Failure Reason</TableHead>
                  <TableHead>Last Activity</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sagas.map((saga) => (
                  <TableRow key={saga.executionId}>
                    <TableCell className="font-mono text-sm">
                      {saga.executionId.slice(0, 12)}...
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={saga.status} requiresHumanIntervention={saga.requiresHumanIntervention} />
                    </TableCell>
                    <TableCell className="font-medium">{saga.inactiveDurationHuman}</TableCell>
                    <TableCell>{saga.recoveryAttempts}</TableCell>
                    <TableCell className="max-w-[200px] truncate" title={saga.failureReason}>
                      <span className="text-sm text-muted-foreground">
                        {saga.failureReason ? (typeof saga.failureReason === 'string' ? saga.failureReason.slice(0, 50) : JSON.stringify(saga.failureReason).slice(0, 50)) + '...' : '-'}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(saga.lastActivityAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleInspect(saga)}
                      >
                        Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {pagination && pagination.total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {sagas.length} of {pagination.total} sagas</span>
          {pagination.hasMore && (
            <span>Use API with offset/limit for more results</span>
          )}
        </div>
      )}

      {/* Detail Dialog */}
      <SagaDetailDialog
        saga={selectedSaga}
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) setSelectedSaga(null);
        }}
        onActionComplete={() => {
          setDetailOpen(false);
          setSelectedSaga(null);
          loadSagas();
        }}
      />
    </div>
  );
}
