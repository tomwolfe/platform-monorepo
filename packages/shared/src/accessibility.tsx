/**
 * Accessibility Utilities and Hooks
 *
 * Provides accessibility (a11y) utilities, hooks, and components
 * to ensure WCAG 2.1 AA compliance.
 *
 * Usage:
 * ```typescript
 * import { useKeyboardFocus, useScreenReader, AriaButton } from '@repo/shared';
 *
 * // Track keyboard focus
 * const { isFocused } = useKeyboardFocus();
 *
 * // Screen reader announcements
 * const { announce } = useScreenReader();
 * announce('Reservation confirmed');
 *
 * // Accessible button
 * <AriaButton aria-label="Close dialog" onClick={handleClose}>
 *   ×
 * </AriaButton>
 * ```
 *
 * @see Phase 4.1: Accessibility
 */

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Track keyboard focus state
 * Returns true when user is navigating with keyboard
 */
export function useKeyboardFocus(): { isFocused: boolean } {
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        setIsFocused(true);
      }
    };

    const handleMouseDown = () => {
      setIsFocused(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  return { isFocused };
}

/**
 * Screen reader announcement hook
 * Announces messages to screen readers via aria-live region
 */
export function useScreenReader(): {
  announce: (message: string, priority?: 'polite' | 'assertive') => void;
  clear: () => void;
} {
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<'polite' | 'assertive'>('polite');

  const announce = useCallback((newMessage: string, newPriority: 'polite' | 'assertive' = 'polite') => {
    setMessage('');
    setPriority(newPriority);
    // Clear and set message to trigger announcement
    setTimeout(() => {
      setMessage(newMessage);
    }, 100);
  }, []);

  const clear = useCallback(() => {
    setMessage('');
  }, []);

  useEffect(() => {
    if (!message) return;

    const liveRegion = document.getElementById('a11y-live-region');
    if (liveRegion) {
      liveRegion.textContent = message;
      liveRegion.setAttribute('aria-live', priority);
    }
  }, [message, priority]);

  return { announce, clear };
}

/**
 * Trap focus within a container (for modals/dialogs)
 * Returns ref to attach to container
 */
export function useFocusTrap(enabled: boolean = true): {
  ref: React.RefObject<HTMLElement>;
} {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!enabled || !ref.current) return;

    const container = ref.current;
    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        // Tab
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);

    // Focus first element
    firstElement?.focus();

    return () => {
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]);

  return { ref };
}

/**
 * Handle keyboard interactions for custom interactive elements
 */
export function useKeyboardInteractive(
  onActivate: () => void,
  options: { onEscape?: () => void; onClose?: () => void } = {}
) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }

      if (e.key === 'Escape' && options.onEscape) {
        e.preventDefault();
        options.onEscape();
      }

      if (e.key === 'Escape' && options.onClose) {
        e.preventDefault();
        options.onClose();
      }
    },
    [onActivate, options.onEscape, options.onClose]
  );
}

// ============================================================================
// ACCESSIBILITY COMPONENTS
// ============================================================================

/**
 * Visually hidden text for screen readers
 */
export function VisuallyHidden({
  children,
  as = 'span',
}: {
  children: React.ReactNode;
  as?: keyof JSX.IntrinsicElements;
}) {
  const Component = as;
  return (
    <Component
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        borderWidth: 0,
      }}
    >
      {children}
    </Component>
  );
}

/**
 * Accessible button with proper keyboard handling
 */
export interface AriaButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  as?: keyof JSX.IntrinsicElements;
  label?: string;
}

export function AriaButton({
  as = 'button',
  label,
  children,
  ...props
}: AriaButtonProps) {
  const Component = as;
  return (
    <Component
      {...props}
      aria-label={label || props['aria-label']}
    >
      {children}
    </Component>
  );
}

/**
 * Live region for screen reader announcements
 * Place this once in your app layout
 */
export function LiveRegion() {
  return (
    <div
      id="a11y-live-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        borderWidth: 0,
      }}
    />
  );
}

/**
 * Skip link for keyboard users to bypass navigation
 */
export function SkipLink({
  href = '#main-content',
  children = 'Skip to main content',
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      style={{
        position: 'absolute',
        left: '-9999px',
        zIndex: 999,
        padding: '1rem',
        background: '#000',
        color: '#fff',
        textDecoration: 'none',
      }}
      onFocus={(e) => {
        e.currentTarget.style.left = '0';
      }}
      onBlur={(e) => {
        e.currentTarget.style.left = '-9999px';
      }}
    >
      {children}
    </a>
  );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate unique ID for aria-labelledby/aria-describedby
 */
let uniqueIdCounter = 0;
export function generateAriaId(prefix: string = 'aria'): string {
  return `${prefix}-${++uniqueIdCounter}`;
}

/**
 * Check if element is focusable
 */
export function isFocusable(element: HTMLElement): boolean {
  const focusableTags = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'AREA'];
  const hasTabindex = element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1';
  const isFocusableTag = focusableTags.includes(element.tagName);

  return isFocusableTag || hasTabindex;
}

/**
 * Get all focusable elements within a container
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  );
}

/**
 * Move focus to element and ensure it's scrolled into view
 */
export function moveFocus(element: HTMLElement | null): void {
  if (!element) return;

  element.focus();
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * Announce message to screen readers (alternative to hook)
 */
export function announceToScreenReader(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  const liveRegion = document.getElementById('a11y-live-region');
  if (liveRegion) {
    liveRegion.textContent = '';
    liveRegion.setAttribute('aria-live', priority);
    setTimeout(() => {
      liveRegion.textContent = message;
    }, 100);
  }
}

// ============================================================================
// ACCESSIBILITY UTILITIES
// ============================================================================

/**
 * Color contrast checker (WCAG 2.1 AA)
 * Returns contrast ratio and whether it passes AA/AAA
 */
export function checkColorContrast(
  foreground: string,
  background: string
): {
  ratio: number;
  passesAA: boolean;
  passesAAA: boolean;
  level: 'AA' | 'AAA' | 'fail';
} {
  // Simple luminance calculation
  function getLuminance(hex: string): number {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;

    const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  const l1 = getLuminance(foreground);
  const l2 = getLuminance(background);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  // WCAG 2.1 AA requires 4.5:1 for normal text, 3:1 for large text
  // WCAG 2.1 AAA requires 7:1 for normal text, 4.5:1 for large text
  const passesAA = ratio >= 4.5;
  const passesAAA = ratio >= 7;

  return {
    ratio,
    passesAA,
    passesAAA,
    level: passesAAA ? 'AAA' : passesAA ? 'AA' : 'fail',
  };
}

/**
 * Check if page meets accessibility standards
 */
export interface AccessibilityReport {
  score: number;
  issues: AccessibilityIssue[];
  passed: boolean;
}

export interface AccessibilityIssue {
  rule: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  elements: number;
  recommendation: string;
}

export async function runAccessibilityAudit(): Promise<AccessibilityReport> {
  const issues: AccessibilityIssue[] = [];

  // Check for images without alt text
  const imagesWithoutAlt = document.querySelectorAll('img:not([alt])');
  if (imagesWithoutAlt.length > 0) {
    issues.push({
      rule: 'image-alt',
      impact: 'critical',
      description: 'Images must have alt text',
      elements: imagesWithoutAlt.length,
      recommendation: 'Add descriptive alt text to all images',
    });
  }

  // Check for form labels
  const inputsWithoutLabel = document.querySelectorAll(
    'input:not([aria-label]):not([aria-labelledby]):not([id]), select:not([aria-label]):not([aria-labelledby]), textarea:not([aria-label]):not([aria-labelledby])'
  );
  const labelsForInputs = document.querySelectorAll('label[for]');
  const labeledIds = Array.from(labelsForInputs).map((label) => label.getAttribute('for'));

  const unlabeledInputs = Array.from(inputsWithoutLabel).filter(
    (input) => !labeledIds.includes(input.id)
  );

  if (unlabeledInputs.length > 0) {
    issues.push({
      rule: 'form-label',
      impact: 'critical',
      description: 'Form inputs must have labels',
      elements: unlabeledInputs.length,
      recommendation: 'Add labels or aria-label to all form inputs',
    });
  }

  // Check for buttons without accessible names
  const buttonsWithoutName = document.querySelectorAll(
    'button:not([aria-label]):not([aria-labelledby]):not([title]):empty'
  );
  if (buttonsWithoutName.length > 0) {
    issues.push({
      rule: 'button-name',
      impact: 'critical',
      description: 'Buttons must have accessible names',
      elements: buttonsWithoutName.length,
      recommendation: 'Add aria-label or visible text to all buttons',
    });
  }

  // Check for links without href
  const linksWithoutHref = document.querySelectorAll('a:not([href])');
  if (linksWithoutHref.length > 0) {
    issues.push({
      rule: 'link-href',
      impact: 'serious',
      description: 'Links must have href attribute',
      elements: linksWithoutHref.length,
      recommendation: 'Add href attribute to all anchor tags or use buttons for actions',
    });
  }

  // Check for heading hierarchy
  const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let lastLevel = 0;
  let skippedLevels = 0;
  headings.forEach((heading) => {
    const level = parseInt(heading.tagName[1]);
    if (level > lastLevel + 1 && lastLevel > 0) {
      skippedLevels++;
    }
    lastLevel = level;
  });

  if (skippedLevels > 0) {
    issues.push({
      rule: 'heading-order',
      impact: 'moderate',
      description: 'Heading levels should not be skipped',
      elements: skippedLevels,
      recommendation: 'Use heading levels in sequential order (h1 → h2 → h3)',
    });
  }

  // Check for lang attribute
  const htmlElement = document.documentElement;
  if (!htmlElement.hasAttribute('lang')) {
    issues.push({
      rule: 'html-lang',
      impact: 'serious',
      description: 'HTML element must have lang attribute',
      elements: 1,
      recommendation: 'Add lang attribute to HTML element (e.g., lang="en")',
    });
  }

  // Check for document title
  if (!document.title) {
    issues.push({
      rule: 'document-title',
      impact: 'serious',
      description: 'Document must have a title',
      elements: 1,
      recommendation: 'Add a descriptive title to the page',
    });
  }

  // Calculate score
  const criticalWeight = 10;
  const seriousWeight = 5;
  const moderateWeight = 2;
  const minorWeight = 1;

  let penalty = 0;
  issues.forEach((issue) => {
    switch (issue.impact) {
      case 'critical':
        penalty += criticalWeight * issue.elements;
        break;
      case 'serious':
        penalty += seriousWeight * issue.elements;
        break;
      case 'moderate':
        penalty += moderateWeight * issue.elements;
        break;
      case 'minor':
        penalty += minorWeight * issue.elements;
        break;
    }
  });

  const maxScore = 100;
  const score = Math.max(0, maxScore - penalty);

  return {
    score,
    issues,
    passed: score >= 90 && issues.filter((i) => i.impact === 'critical').length === 0,
  };
}

// ============================================================================
// END OF FILE
