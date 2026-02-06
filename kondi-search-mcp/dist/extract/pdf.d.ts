export interface PdfExtractResult {
    text: string;
    pageCount?: number;
    metadata?: Record<string, string>;
}
export declare function extractPdfText(buffer: ArrayBuffer): Promise<PdfExtractResult>;
export declare function isPdf(contentType: string, buffer?: ArrayBuffer): boolean;
//# sourceMappingURL=pdf.d.ts.map