"use client";

import { useState } from "react";

import { copyText } from "@/lib/utils";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: UseCopyToClipboardOptions = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};
