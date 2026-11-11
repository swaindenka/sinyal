/** Oyuncuya hata kodu olarak dönen oyun kuralı ihlali. */
export class GameError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}
