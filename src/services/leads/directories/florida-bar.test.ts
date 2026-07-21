import { describe, it, expect } from 'vitest';
import { decodeCfemail, parseResults, toLead, floridaBar } from './florida-bar.js';

describe('decodeCfemail', () => {
  it('decodes with a zero key', () => {
    // '00' key + raw ascii bytes of "jane@doe.com"
    expect(decodeCfemail('006a616e6540646f652e636f6d')).toBe('jane@doe.com');
  });
  it('decodes with a non-zero XOR key', () => {
    // key 0x42, bytes of "x@y.co" each XORed with 0x42
    expect(decodeCfemail('423a023b6c212d')).toBe('x@y.co');
  });
});

const BLOCK = `
<li class="profile-compact">
  <p class="profile-name"><a href="/x">Jane A. Doe</a></p>
  <span>Bar #123456</span>
  <div class="profile-contact">
    <p>Doe Immigration Law<br>100 Main St<br>Tampa, FL 33601</p>
    <a href="tel:813-555-0100">Call</a>
    <a class="__cf_email__" data-cfemail="006a616e6540646f652e636f6d">[email&#160;protected]</a>
  </div>
</li>`;

describe('parseResults + toLead', () => {
  it('parses an attorney block into a person-shaped Lead', () => {
    const [a] = parseResults(BLOCK);
    expect(a).toMatchObject({ name: 'Jane A. Doe', barNum: '123456', firm: 'Doe Immigration Law', city: 'Tampa' });
    const lead = toLead(a!);
    expect(lead).toMatchObject({
      title: 'Doe Immigration Law', // firm is the company
      contactName: 'Jane A. Doe', // the named person
      email: 'jane@doe.com',
      emailConfidence: 'scraped',
      phone: '813-555-0100',
      category: 'Attorney',
    });
    expect(lead?.address).toContain('100 Main St');
  });

  it('drops attorneys with no public email', () => {
    expect(toLead({ name: 'No Email', barNum: '1', firm: 'X', address: '', city: '', phone: '', email: '' })).toBeNull();
  });

  it('drops government attorneys (opposing counsel)', () => {
    expect(
      toLead({ name: 'Gov Lawyer', barNum: '2', firm: 'DHS', address: '', city: '', phone: '', email: 'a@uscis.gov' }),
    ).toBeNull();
  });

  it('falls back to the person name as title when firm is missing', () => {
    const lead = toLead({ name: 'Solo Sam', barNum: '3', firm: '', address: '', city: 'Miami', phone: '', email: 's@sam.com' });
    expect(lead?.title).toBe('Solo Sam');
  });
});

describe('floridaBar.covers', () => {
  it('matches immigration lawyers in Florida', () => {
    expect(floridaBar.covers({ industry: 'immigration lawyer', location: 'Tampa, FL' })).toBe(true);
    expect(floridaBar.covers({ industry: 'attorney', location: 'Miami, Florida' })).toBe(true);
  });
  it('rejects non-legal or non-Florida queries', () => {
    expect(floridaBar.covers({ industry: 'bakery', location: 'Tampa, FL' })).toBe(false);
    expect(floridaBar.covers({ industry: 'lawyer', location: 'Austin, TX' })).toBe(false);
  });
});
