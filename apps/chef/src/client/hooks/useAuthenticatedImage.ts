import { useEffect, useState } from "react";
import { authenticatedFetch } from "@every-app/sdk/core";

export function useAuthenticatedImage(imageKey: string | null) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!imageKey) {
      setImageSrc(null);
      return;
    }

    // This hook expects R2 keys only. Data URLs should be handled
    // upstream in the component (e.g., MessageBubble handles data URLs directly).

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
