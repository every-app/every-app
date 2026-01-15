import { useState, useRef } from "react";
import { fileToDataUrl } from "../utils/file";

export function useImageUpload() {
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectImage = async (file: File) => {
    if (file.type.startsWith("image/")) {
      setSelectedImage(file);
      const dataUrl = await fileToDataUrl(file);
      setImagePreview(dataUrl);
    }
  };

  const removeImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return {
    selectedImage,
    imagePreview,
    fileInputRef,
    selectImage,
    removeImage,
  };
}
