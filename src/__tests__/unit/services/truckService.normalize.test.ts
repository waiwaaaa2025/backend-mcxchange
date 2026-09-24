import { normalizeTruckInput } from '../../../services/truckService';

describe('normalizeTruckInput', () => {
  it('cleans a full trailer entry', () => {
    expect(
      normalizeTruckInput({
        equipmentType: 'trailer' as any,
        make: '  Great Dane ',
        model: '',
        year: '2019' as any,
        price: '$24,500' as any,
        trailerType: 'Reefer',
        lengthFt: '53' as any,
        vin: '1grab0622kw123456',
        condition: 'good' as any,
      })
    ).toEqual({
      equipmentType: 'TRAILER',
      make: 'Great Dane',
      model: '',
      year: 2019,
      price: 24500,
      trailerType: 'Reefer',
      lengthFt: 53,
      vin: '1GRAB0622KW123456',
      condition: 'GOOD',
    });
  });

  it('defaults unknown types to TRUCK and drops bad numbers and conditions', () => {
    expect(
      normalizeTruckInput({ equipmentType: 'boat' as any, make: 'Volvo', price: 'abc' as any, mileage: -5, condition: 'MINT' as any })
    ).toEqual({ equipmentType: 'TRUCK', make: 'Volvo', price: null, mileage: null, condition: null });
  });

  it('only returns keys present in the input (partial update)', () => {
    expect(normalizeTruckInput({ price: 1000 })).toEqual({ price: 1000 });
  });
});
