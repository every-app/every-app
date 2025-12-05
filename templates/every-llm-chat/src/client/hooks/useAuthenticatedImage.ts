import { useEffect, useState } from "react";
import { authenticatedFetch } from "@/embedded-sdk/client";

export function useAuthenticatedImage(imageKey: string | null) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!imageKey) {
      setImageSrc(null);
      return;
    }

    // If it's already a data URL or http URL, just use it
    if (imageKey.startsWith("data:") || imageKey.startsWith("http")) {
      setImageSrc(imageKey);
      return;
    }

    let objectUrl: string | null = null;
    let mounted = true;

    const fetchImage = async () => {
      setLoading(true);
      setError(false);
      try {
        const response = await authenticatedFetch(
          `/api/image?key=${encodeURIComponent(imageKey)}`,
        );

        if (!response.ok) throw new Error("Failed to fetch image");

        const blob = await response.blob();
        if (mounted) {
          objectUrl = URL.createObjectURL(blob);
          setImageSrc(objectUrl);
        }
      } catch (err) {
        if (mounted) {
          console.error("Failed to load image:", err);
          setError(true);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchImage();

    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageKey]);

  return { imageSrc, loading, error };
}
