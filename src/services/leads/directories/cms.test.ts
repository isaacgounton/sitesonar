import { describe, it, expect } from 'vitest';
import { datasetFor, rowToLead, cmsCareCompare } from './cms.js';

describe('datasetFor', () => {
  it('maps facility terms to Care Compare datasets', () => {
    expect(datasetFor('home health agency')?.category).toBe('Home Health Agency');
    expect(datasetFor('hospice care')?.category).toBe('Hospice');
    expect(datasetFor('dialysis center')?.category).toBe('Dialysis Facility');
  });
  it('returns undefined for unrelated terms', () => {
    expect(datasetFor('dentist')).toBeUndefined();
    expect(datasetFor('lawyer')).toBeUndefined();
  });
});

describe('rowToLead', () => {
  it('maps a Care Compare row and formats a 10-digit phone', () => {
    const lead = rowToLead(
      { provider_name: 'SUNSHINE HOME HEALTH', address: '100 BAY ST', citytown: 'TAMPA', state: 'FL', telephone_number: '8135551234' },
      'Home Health Agency',
    );
    expect(lead).toMatchObject({
      title: 'SUNSHINE HOME HEALTH',
      phone: '813-555-1234',
      address: '100 BAY ST, TAMPA, FL',
      category: 'Home Health Agency',
    });
    expect(lead?.email).toBeUndefined();
  });
  it('tolerates alternate field names across datasets', () => {
    const lead = rowToLead({ facility_name: 'X Dialysis', city: 'Miami', provider_state: 'FL', phone: '3050000000' }, 'Dialysis Facility');
    expect(lead).toMatchObject({ title: 'X Dialysis', address: 'Miami, FL', phone: '305-000-0000' });
  });
  it('returns null with no provider name', () => {
    expect(rowToLead({ citytown: 'TAMPA' }, 'Hospice')).toBeNull();
  });
});

describe('cmsCareCompare.covers', () => {
  it('matches a facility type in a US state', () => {
    expect(cmsCareCompare.covers({ industry: 'home health', location: 'Tampa, FL' })).toBe(true);
  });
  it('rejects non-facility or non-US queries', () => {
    expect(cmsCareCompare.covers({ industry: 'dentist', location: 'Tampa, FL' })).toBe(false);
    expect(cmsCareCompare.covers({ industry: 'hospice', location: 'Lyon, France' })).toBe(false);
  });
});
