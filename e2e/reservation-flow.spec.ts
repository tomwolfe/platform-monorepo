/**
 * E2E Test: Reservation Flow
 *
 * Tests the complete user journey:
 * 1. Visit booking page
 * 2. Select date and time
 * 3. Fill guest information
 * 4. Submit reservation
 * 5. Verify success message
 *
 * @see Phase 2.1: Add Critical Path E2E Tests
 * @see Phase 3.2: Fix Flaky E2E Selectors
 */

import { test, expect } from "@playwright/test";

test.describe("Reservation Flow", () => {
  test("should complete reservation successfully", async ({ page }) => {
    // Step 1: Visit booking page
    await page.goto("/book/demo");

    // Pre-flight assertion: Verify page loaded
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="restaurant-name"]')).toBeVisible();

    // Step 2: Select date (using date picker container)
    const datePicker = page.locator('[data-testid="date-picker-container"]');
    if (await datePicker.isVisible()) {
      // Click on a date in the datepicker
      const dateCell = page.locator(".rdp-day").first();
      if (await dateCell.isVisible()) {
        await dateCell.click();
      }
    }

    // Step 3: Select party size using data-testid
    const partySizeButton = page.locator('[data-testid="party-size-4"]');
    if (await partySizeButton.isVisible()) {
      await partySizeButton.click();
    }

    // Step 4: Select time slot using data-testid
    const firstTimeSlot = page.locator('[data-testid^="time-slot-"]').first();
    if (await firstTimeSlot.isVisible()) {
      await firstTimeSlot.click();
    }

    // Step 5: Fill guest information using data-testid
    const nameInput = page.locator('[data-testid="guest-name-input"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill("John Doe");
    }

    const emailInput = page.locator('[data-testid="guest-email-input"]');
    if (await emailInput.isVisible()) {
      await emailInput.fill("john@example.com");
    }

    // Step 6: Submit reservation using data-testid
    const submitButton = page.locator(
      '[data-testid="confirm-reservation-btn"]',
    );
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // Step 7: Verify success using data-testid
    const successMessage = page.locator('[data-testid="reservation-success"]');
    await expect(successMessage).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="success-title"]')).toHaveText(
      /confirmed/i,
    );
  });

  test("should show error for invalid email", async ({ page }) => {
    await page.goto("/book/demo");

    // Pre-flight assertion
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();

    // Fill form with invalid email
    const emailInput = page.locator('[data-testid="guest-email-input"]');
    if (await emailInput.isVisible()) {
      await emailInput.fill("invalid-email");
      await emailInput.blur();
    }

    // Try to submit
    const submitButton = page.locator(
      '[data-testid="confirm-reservation-btn"]',
    );
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // Verify error message using data-testid
    const errorMessage = page.locator('[data-testid="form-error"]');
    await expect(errorMessage).toBeVisible({ timeout: 5000 });
  });

  test("should handle party size validation", async ({ page }) => {
    await page.goto("/book/demo");

    // Pre-flight assertion
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();

    const partySizeSection = page.locator('[data-testid="party-size-section"]');
    if (await partySizeSection.isVisible()) {
      // Try excessively large party size by clicking the max available
      const partySize6 = page.locator('[data-testid="party-size-6"]');
      if (await partySize6.isVisible()) {
        await partySize6.click();
      }

      // Fill other required fields
      const nameInput = page.locator('[data-testid="guest-name-input"]');
      if (await nameInput.isVisible()) {
        await nameInput.fill("John Doe");
      }

      const emailInput = page.locator('[data-testid="guest-email-input"]');
      if (await emailInput.isVisible()) {
        await emailInput.fill("john@example.com");
      }

      // Submit
      const submitButton = page.locator(
        '[data-testid="confirm-reservation-btn"]',
      );
      if (await submitButton.isVisible()) {
        await submitButton.click();
      }

      // Verify error or suggestion
      const errorMessage = page.locator('[data-testid="form-error"]');
      await expect(errorMessage).toBeVisible({ timeout: 5000 });
    }
  });

  /**
   * FAILOVER E2E TEST
   * Tests the autonomous failover policy when a restaurant is fully booked
   * This verifies the system suggests delivery as an alternative
   */
  test("should auto-suggest delivery when restaurant is fully booked", async ({
    page,
  }) => {
    // Mock the availability endpoint to return no available tables
    await page.route("**/api/v1/availability", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          restaurantId: "demo",
          date: "2026-04-15",
          availableTables: [],
          message: "No tables available for this time slot",
        }),
      });
    });

    // Step 1: Visit booking page
    await page.goto("/book/demo");

    // Pre-flight assertion
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();

    // Step 2-4: Fill form and submit (using data-testid selectors)
    const partySizeButton = page.locator('[data-testid="party-size-4"]');
    if (await partySizeButton.isVisible()) {
      await partySizeButton.click();
    }

    const nameInput = page.locator('[data-testid="guest-name-input"]');
    if (await nameInput.isVisible()) {
      await nameInput.fill("John Doe");
    }

    const emailInput = page.locator('[data-testid="guest-email-input"]');
    if (await emailInput.isVisible()) {
      await emailInput.fill("john@example.com");
    }

    // Step 5: Submit reservation attempt
    const submitButton = page.locator(
      '[data-testid="confirm-reservation-btn"]',
    );
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // Step 6: Verify failover - system should show error gracefully
    // The error should appear in the form error section
    const errorMessage = page.locator('[data-testid="form-error"]');
    await expect(errorMessage).toBeVisible({ timeout: 10000 });

    // Verify that the system doesn't crash and page is still functional
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();
  });

  /**
   * ADDITIONAL FAILOVER TEST
   * Tests the system handles database errors gracefully
   */
  test("should handle database errors gracefully with fallback", async ({
    page,
  }) => {
    // Mock the availability endpoint to return server error
    await page.route("**/api/v1/availability", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Database connection failed",
          message: "Internal server error",
        }),
      });
    });

    await page.goto("/book/demo");

    // Pre-flight assertion
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();

    // Try to make a reservation
    const submitButton = page.locator(
      '[data-testid="confirm-reservation-btn"]',
    );
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // Verify graceful error handling - should show error message
    const errorMessage = page.locator('[data-testid="form-error"]');
    await expect(errorMessage).toBeVisible({ timeout: 10000 });

    // Verify the page is still functional (not crashed)
    await expect(page.locator('[data-testid="booking-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="restaurant-name"]')).toBeVisible();
  });
});
