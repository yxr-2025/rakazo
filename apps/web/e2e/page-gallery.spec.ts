import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { buildPageRuntime } from "../../../packages/page-kit/src/runtime-build";

let runtime: string;
test.beforeAll(async () => {
  runtime = await buildPageRuntime();
});

async function aligned(track: Locator, index: number) {
  await expect
    .poll(() =>
      track.evaluate((node, slide) => {
        const photo = node.children[slide];
        return photo
          ? Math.abs(photo.getBoundingClientRect().left - node.getBoundingClientRect().left)
          : Infinity;
      }, index),
    )
    .toBeLessThan(1);
}

for (const lang of ["en", "he"]) {
  test(`page gallery keeps photos and controls together in ${lang}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 720, height: 480 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const photos = ["First", "Second", "Third"].map((alt, index) => ({
      alt,
      src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="${["linen", "lightblue", "lightgray"][index]}"/><text x="300" y="165" text-anchor="middle" font-size="48">${alt}</text></svg>`)}`,
    }));
    const code = `exports.default = function GalleryPage() {
      return React.createElement(Page, { title: "Photo gallery", lang: ${JSON.stringify(lang)} },
        React.createElement(Gallery, { photos: ${JSON.stringify(photos)}, height: 240 }));
    };`;
    // Run the same bundled runtime and Page language handling as the sandboxed viewer.
    await page.setContent(
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );
    await page.addScriptTag({ content: runtime });
    await page.evaluate(
      (boot) => {
        (
          window as Window & { RakazoPage?: { mount: (input: typeof boot) => void } }
        ).RakazoPage?.mount(boot);
      },
      { code, theme: "light", errorTitle: "Unable to show page" },
    );

    const track = page.locator(".rk-gallery-track");
    const dots = page.locator(".rk-gallery-dots button");
    await expect(page.locator("main")).toHaveAttribute("dir", lang === "he" ? "rtl" : "ltr");
    await aligned(track, 0);
    await dots.nth(1).click();
    await aligned(track, 1);
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true");

    // Arrow keys follow the physical position of the next photo in either direction.
    await track.focus();
    const next = lang === "he" ? "ArrowLeft" : "ArrowRight";
    const previous = lang === "he" ? "ArrowRight" : "ArrowLeft";
    await page.keyboard.press(next);
    await aligned(track, 2);
    await expect(dots.nth(2)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press(next);
    await aligned(track, 2);
    await page.keyboard.press(previous);
    await aligned(track, 1);
    await page.keyboard.press(previous);
    await aligned(track, 0);
    await page.keyboard.press(previous);
    await aligned(track, 0);

    // Native scrolling must update the selected marker rather than leaving no dot current.
    await track.evaluate(
      (node, direction) => {
        node.scrollTo({ left: direction * node.clientWidth, behavior: "instant" });
      },
      lang === "he" ? -1 : 1,
    );
    await aligned(track, 1);
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(".rk-gallery-dots button[aria-current]")).toHaveCount(1);
    await testInfo.attach(`page-gallery-${lang}`, {
      body: await page.screenshot({ animations: "disabled", fullPage: true }),
      contentType: "image/png",
    });
  });
}
