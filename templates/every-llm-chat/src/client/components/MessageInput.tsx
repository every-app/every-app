import { useState } from "react";
import { Send, Image, X, Square } from "lucide-react";
import { useImageUpload } from "@/client/hooks/useImageUpload";

interface MessageInputProps {
  onSendMessage: (message: string, imageFile?: File) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
}

export function MessageInput({
  onSendMessage,
  disabled,
  isStreaming = false,
  onStop,
}: MessageInputProps) {
  const [message, setMessage] = useState("");
  const {
    selectedImage,
    imagePreview,
    fileInputRef,
    selectImage,
    removeImage,
  } = useImageUpload();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((message.trim() || selectedImage) && !disabled && !isStreaming) {
      // Send message immediately with the File object (no need to upload first!)
      onSendMessage(message.trim(), selectedImage || undefined);
      setMessage("");
      removeImage();
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      selectImage(file);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const isDisabled = disabled || isStreaming;

  return (
    <div className="border-t border-base-300 bg-base-100 p-4 flex justify-center">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2 w-full max-w-2xl"
      >
        {imagePreview && (
          <div className="relative inline-block w-32 h-32">
            <img
              src={imagePreview}
              alt="Selected"
              className="w-full h-full object-cover rounded-lg border border-base-300"
            />
            <button
              type="button"
              onClick={removeImage}
              className="absolute -top-2 -right-2 btn btn-circle btn-sm btn-error"
              aria-label="Remove image"
              disabled={isStreaming}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
            disabled={isDisabled}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled}
            className="btn btn-ghost btn-square"
            aria-label="Attach image"
          >
            <Image size={18} />
          </button>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming ? "AI is responding..." : "Ask anything..."
            }
            disabled={isDisabled}
            className="textarea textarea-bordered flex-1 resize-none min-h-[50px] max-h-[200px]"
            rows={1}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="btn btn-error"
              aria-label="Stop generating"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={(!message.trim() && !selectedImage) || isDisabled}
              className="btn btn-primary"
              aria-label="Send message"
            >
              <Send size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
