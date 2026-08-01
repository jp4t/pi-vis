import { expect, test } from "@playwright/test";

test("late-mounted sidebar working dots keep one phase without animating their ancestor", async ({
  page,
}) => {
  await page.goto("/");
  const composer = page.locator(".composer__textarea");
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator(".composer__attach-btn")).toBeEnabled({ timeout: 20_000 });

  await composer.fill("Show synchronized sidebar activity");
  await composer.press("Enter");

  const workspaceList = page.locator(".sidebar__workspaces");
  await expect(workspaceList).toBeVisible();

  const result = await workspaceList.evaluate(async (list) => {
    const { synchronizeWorkingIndicatorAnimation } = await import(
      "/src/components/shell/Sidebar.tsx"
    );
    const firstDot = document.createElement("span");
    firstDot.className = "status-dot status-dot--streaming";
    list.append(firstDot);
    synchronizeWorkingIndicatorAnimation(firstDot);

    await new Promise((resolve) => setTimeout(resolve, 275));
    const lateDot = document.createElement("span");
    lateDot.className = "status-dot status-dot--streaming";
    list.append(lateDot);
    synchronizeWorkingIndicatorAnimation(lateDot);

    const differences: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const firstOpacity = Number.parseFloat(getComputedStyle(firstDot).opacity);
      const lateOpacity = Number.parseFloat(getComputedStyle(lateDot).opacity);
      differences.push(Math.abs(firstOpacity - lateOpacity));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }

    const styles = {
      clockAnimation: getComputedStyle(list).animationName,
      firstAnimation: getComputedStyle(firstDot).animationName,
      lateAnimation: getComputedStyle(lateDot).animationName,
      maxDifference: Math.max(...differences),
    };
    firstDot.remove();
    lateDot.remove();
    return styles;
  });

  expect(result.clockAnimation).toBe("none");
  expect(result.firstAnimation).toBe("status-dot-pulse");
  expect(result.lateAnimation).toBe("status-dot-pulse");
  expect(result.maxDifference).toBeLessThan(0.01);
});
