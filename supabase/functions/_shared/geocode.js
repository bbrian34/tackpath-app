/** U.S. street-range fallback. Never substitutes city/ZIP centroids or ambiguous matches. */
export async function censusGeocode(address){
 const postal=String(address).match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*(?:,?\s*USA)?$/i);
 const house=String(address).match(/^\s*(\d+)\b/);if(!postal||!house)throw Error('A complete U.S. street address, state and ZIP is required for fallback geocoding');
 const response=await fetch('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address='+encodeURIComponent(address),{signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Address geocoding is temporarily unavailable');const data=await response.json(),matches=data.result?.addressMatches||[];
 if(matches.length!==1)throw Error(matches.length?'Address match is ambiguous':'Address could not be located');const match=matches[0],c=match.addressComponents||{};
 const words=String(address).toUpperCase().replace(/[^A-Z0-9]+/g,' ');if(c.zip!==postal[2]||c.state!==postal[1].toUpperCase()||!match.matchedAddress?.startsWith(house[1]+' ')||!String(c.streetName||'').split(/\s+/).every(w=>words.split(' ').includes(w)))throw Error('Address match requires correction');
 const lat=match.coordinates?.y,lng=match.coordinates?.x;if(!Number.isFinite(lat)||!Number.isFinite(lng))throw Error('Address coordinates unavailable');return {lat,lng,provider:'us_census',precision:'street_range',matched_address:match.matchedAddress};
}
