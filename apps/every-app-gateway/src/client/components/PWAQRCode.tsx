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
    <div className="space-y-2">
      <div className="bg-white p-3 rounded-lg w-fit">
        <QRCodeSVG value={pwaUrl} size={size} level="M" />
      </div>
      <p className="text-xs text-base-content/50">
        Or visit{" "}
        <code className="bg-base-300 px-1.5 py-0.5 rounded text-base-content/70">
          {pwaUrl}
        </code>
      </p>
    </div>
  );
}
