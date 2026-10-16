import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";

interface PWAQRCodeProps {
  size?: number;
}

export function PWAQRCode({ size = 140 }: PWAQRCodeProps) {
  const pwaUrl = useMemo(
    () =>
      typeof window === "undefined"
        ? "/?pwa=true"
        : `${window.location.origin}/?pwa=true`,
    [],
  );

  return (
    <div className="space-y-3">
      {/* Always white: a QR code needs a light background to scan. */}
      <div className="w-fit rounded-lg border border-border bg-white p-3">
        <QRCodeSVG value={pwaUrl} size={size} level="M" />
      </div>
      <p className="text-xs text-muted-foreground">
        Or visit{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono break-all text-foreground">
          {pwaUrl}
        </code>
      </p>
    </div>
  );
}
