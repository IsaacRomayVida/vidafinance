export const _mockStorage: {
  files: Array<{ name: string }>;
  signedUrl: string;
  getFilesImpl?: (opts: { prefix: string }) => Promise<[Array<{ name: string }>]>;
  getSignedUrlImpl?: (opts: unknown) => Promise<[string]>;
} = {
  files: [],
  signedUrl: 'https://storage.googleapis.com/signed-url-mock',
};

const makeFile = (name: string) => ({
  name,
  getSignedUrl: jest.fn(async (opts: unknown) => {
    if (_mockStorage.getSignedUrlImpl) return _mockStorage.getSignedUrlImpl(opts);
    return [_mockStorage.signedUrl];
  }),
});

const mockBucket = {
  getFiles: jest.fn(async (opts: { prefix: string }) => {
    if (_mockStorage.getFilesImpl) return _mockStorage.getFilesImpl(opts);
    const matches = _mockStorage.files
      .filter((f) => f.name.startsWith(opts.prefix))
      .map((f) => makeFile(f.name));
    return [matches];
  }),
};

export const getStorage = jest.fn(() => ({
  bucket: jest.fn(() => mockBucket),
}));
