import { describe, it, expect } from 'vitest';
import { taxonomyFor, usStateFrom, cityFrom, resultToLead, nppesNpi } from './nppes.js';

describe('taxonomyFor', () => {
  it('maps healthcare terms to NPPES taxonomy descriptions', () => {
    expect(taxonomyFor('dentist')).toBe('Dentist');
    expect(taxonomyFor('family dental practice')).toBe('Dentist');
    expect(taxonomyFor('physical therapist')).toBe('Physical Therapist');
  });
  it('returns undefined for non-healthcare terms', () => {
    expect(taxonomyFor('immigration lawyer')).toBeUndefined();
    expect(taxonomyFor('bakery')).toBeUndefined();
  });
});

describe('usStateFrom / cityFrom', () => {
  it('resolves a state code from abbreviation or full name', () => {
    expect(usStateFrom('Tampa, FL')).toBe('FL');
    expect(usStateFrom('Austin, Texas')).toBe('TX');
    expect(usStateFrom('Miami, FL 33101')).toBe('FL');
  });
  it('returns undefined when no US state is present', () => {
    expect(usStateFrom('Lyon, France')).toBeUndefined();
  });
  it('extracts the city, blank when only a state is given', () => {
    expect(cityFrom('Tampa, FL')).toBe('Tampa');
    expect(cityFrom('FL')).toBe('');
    expect(cityFrom('Florida')).toBe('');
  });
});

describe('resultToLead', () => {
  it('maps an individual provider (NPI-1) to a person-shaped Lead', () => {
    const lead = resultToLead({
      basic: { first_name: 'RODNEY', last_name: 'ABRAHAMS' },
      addresses: [
        { address_purpose: 'MAILING', address_1: 'PO BOX 1', city: 'TAMPA', state: 'FL' },
        { address_purpose: 'LOCATION', address_1: '2111 W SWANN AVE', city: 'TAMPA', state: 'FL', telephone_number: '813-326-3568' },
      ],
      taxonomies: [{ desc: 'Chiropractor', primary: true }],
    });
    expect(lead).toMatchObject({
      title: 'RODNEY ABRAHAMS',
      contactName: 'RODNEY ABRAHAMS',
      phone: '813-326-3568',
      category: 'Chiropractor',
    });
    expect(lead?.address).toBe('2111 W SWANN AVE, TAMPA, FL'); // LOCATION, not MAILING
    expect(lead?.email).toBeUndefined(); // NPPES carries no email
  });

  it('maps an organization (NPI-2) to firm title + official as contact', () => {
    const lead = resultToLead({
      basic: { organization_name: 'BRIGHT SMILES DENTAL PA', authorized_official_first_name: 'JANE', authorized_official_last_name: 'DOE' },
      addresses: [{ address_purpose: 'LOCATION', address_1: '1 Main St', city: 'Miami', state: 'FL' }],
      taxonomies: [{ desc: 'Dentist, General Practice' }],
    });
    expect(lead).toMatchObject({ title: 'BRIGHT SMILES DENTAL PA', contactName: 'JANE DOE', category: 'Dentist, General Practice' });
  });

  it('returns null with no name', () => {
    expect(resultToLead({ basic: {}, addresses: [] })).toBeNull();
  });
});

describe('nppesNpi.covers', () => {
  it('matches a healthcare specialty in a US state', () => {
    expect(nppesNpi.covers({ industry: 'dentist', location: 'Tampa, FL' })).toBe(true);
  });
  it('rejects non-healthcare or non-US queries', () => {
    expect(nppesNpi.covers({ industry: 'lawyer', location: 'Tampa, FL' })).toBe(false);
    expect(nppesNpi.covers({ industry: 'dentist', location: 'Lyon, France' })).toBe(false);
  });
});
