// Test nautilus patch for validation errors is working as expected
import { publishDDO } from '@deltadao/nautilus';
import { Aquarius } from '@oceanprotocol/lib';

describe('Nautilus validation errors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { services: 'Less than 1 value on schema1:services' },
    'Less than 1 value on schema1:services',
  ])('preserves the Aquarius validation response: %p', async (errors) => {
    jest
      .spyOn(Aquarius.prototype, 'validate')
      .mockResolvedValue({ valid: false, errors } as any);
    // Validation fails before encryption or any blockchain operation is reached.
    const config = {
      chainConfig: { metadataCacheUri: 'http://aquarius.invalid' },
      signer: {
        getAddress: jest
          .fn()
          .mockResolvedValue('0x0000000000000000000000000000000000000001'),
      },
      ddo: { services: [] },
    } as unknown as Parameters<typeof publishDDO>[0];
    const expected =
      typeof errors === 'string' ? errors : JSON.stringify(errors);

    await expect(publishDDO(config)).rejects.toMatchObject({
      message: `Validating Metadata failed: ${expected}`,
      status: 400,
      details: errors,
    });
  });
});
