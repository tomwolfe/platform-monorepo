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
 */

import { test, expect } from "@playwright/test";

test.describe("Reservation Flow", () => {
  test("should complete reservation successfully", async ({ page }) => {
    // Step 1: Visit booking page
    await page.goto("/book/demo");

    // Verify page loaded
    await expect(page).toHaveTitle(/TableStack|Booking/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Step 2: Select date
    const datePicker = page.getByRole("textbox", { name: /date/i });
    if (await datePicker.isVisible()) {
      await datePicker.fill("04/15/2026");
    }

    // Step 3: Select party size
    const partySizeInput = page.getByRole("spinbutton", {
      name: /guests|party size/i,
    });
    if (await partySizeInput.isVisible()) {
      await partySizeInput.fill("4");
    }

    // Step 4: Select time slot
    const timeSlots = page.getByRole("button", {
      name: /\d{1,2}:\d{2}\s*(AM|PM)?/i,
    });
    if ((await timeSlots.count()) > 0) {
      await timeSlots.first().click();
    }

    // Step 5: Fill guest information
    const nameInput = page.getByRole("textbox", { name: /name/i });
    if (await nameInput.isVisible()) {
      await nameInput.fill("John Doe");
    }

    const emailInput = page.getByRole("textbox", { name: /email/i });
    if (await emailInput.isVisible()) {
      await emailInput.fill("john@example.com");
    }

    // Step 6: Submit reservation
    const submitButton = page.getByRole("button", {
      name: /book|reserve|confirm/i,
    });
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // Step 7: Verify success
    const successMessage = page.getByText(
      /success|confirmed|reservation created/i,
    );
    await expect(successMessage).toBeVisible({ timeout: 10000 });
  });

  test("should show error for invalid email", async ({ page }) => {
    await page.goto("/book/demo");

    // Fill form with invalid email
    const emailInput = page.getByRole("textbox", { name: /email/i });
    if (await emailInput.isVisible()) {
      await emailInput.fill("invalid-email");
      await emailInput.blur();
    }

    // Try to submit
    const submitButton = page.getByRole("button", {
      name: /book|reserve|confirm/i,
    });
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // Verify error message
    const errorMessage = page.getByText(/invalid email|email required/i);
    await expect(errorMessage).toBeVisible({ timeout: 5000 });
  });

  test("should handle party size validation", async ({ page }) => {
    await page.goto("/book/demo");

    const partySizeInput = page.getByRole("spinbutton", {
      name: /guests|party size/i,
    });
    if (await partySizeInput.isVisible()) {
      // Try excessively large party size
      await partySizeInput.fill("100");
      await partySizeInput.blur();

      // Submit
      const submitButton = page.getByRole("button", {
        name: /book|reserve|confirm/i,
      });
      if (await submitButton.isVisible()) {
        await submitButton.click();
      }

      // Verify error or suggestion
      const errorMessage = page.getByText(/party size|too large|maximum/i);
      await expect(errorMessage).toBeVisible({ timeout: 5000 });
    }
  });
});
