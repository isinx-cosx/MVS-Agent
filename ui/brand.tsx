/**
 * 品牌图形标（来自 MVS 官网的 `mvs-symbol.svg`）。
 *
 * ## 和原文件的三个差别（都是刻意的）
 *
 * 1. **去掉两层高斯模糊阴影**。原图靠 `feGaussianBlur` + 低透明度做浮起效果，
 *    那在 512px 的海报上好看，在 14px 的侧栏里只是一圈脏点。
 * 2. **填充色用 `currentColor`**。原图是硬编码 `#000000`，在深色界面上等于隐形。
 * 3. **保留原始 512 的 viewBox**，只靠 `size` 缩放 —— 五个花瓣的坐标不必改。
 *
 * ## 一个必须记住的坑
 *
 * 这个项目踩过一次：**同一个页面里的 SVG 箭头正常，SVG 加号一个像素都没画出来**，
 * 原因至今没定位。所以这里：
 *   · 图形标**永远带文字标签**（`内核` / `MVS`），不单独用图标承载语义；
 *   · 不用 `fill-rule` / `mask` / 滤镜这些可能被环境吃掉的东西。
 */

export function MvsSymbol({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="mvs-symbol"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role="img"
      aria-label="MVS"
      focusable="false"
    >
      <path
        d="M293.21 247.85L415.80 260.74L459.50 358.90L438.52 398.01L343.35 360.46L343.35 360.46Z"
        fill="currentColor"
      />
      <path
        d="M293.21 247.85L318.84 368.42L238.99 440.32L195.30 432.45L201.61 330.33L201.61 330.33Z"
        fill="currentColor"
      />
      <path
        d="M293.21 247.85L186.47 309.48L93.41 255.76L87.39 211.78L186.47 186.22L186.47 186.22Z"
        fill="currentColor"
      />
      <path
        d="M293.21 247.85L201.61 165.38L223.95 60.27L263.92 40.96L318.84 127.29L318.84 127.29Z"
        fill="currentColor"
      />
      <path
        d="M293.21 247.85L343.35 135.25L450.21 124.02L480.93 156.06L415.80 234.97L415.80 234.97Z"
        fill="currentColor"
      />
    </svg>
  )
}
