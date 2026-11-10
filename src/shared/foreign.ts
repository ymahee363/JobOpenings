/**
 * Jobs outside India are wanted only when remote (user, 2026-11-10: "if job is other than India and not remote then
 * don't show in list of openings; I want foreign remote jobs only"). Only a location that names a foreign country or
 * city counts as foreign: an unknown Indian town stays listed.
 */
const INDIA = /\bindia\b|bengaluru|bangalore|mumbai|delhi|gurugram|gurgaon|noida|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|coimbatore|karnataka|maharashtra|telangana|tamil nadu|haryana|uttar pradesh|kerala|gujarat|rajasthan|west bengal|thane|navi mumbai|vadodara|surat|lucknow|bhubaneswar|nagpur|visakhapatnam|mysuru|mysore|trivandrum|thiruvananthapuram|mohali|faridabad|ghaziabad/i;
const FOREIGN = /united states|\busa\b|\bu\.s\.|canada|mexico|brazil|argentina|chile|colombia|united kingdom|\buk\b|england|scotland|ireland|europe|european union|\bemea\b|germany|france|spain|italy|netherlands|portugal|poland|belgium|austria|sweden|denmark|finland|norway|switzerland|czech|romania|greece|hungary|croatia|estonia|latvia|lithuania|luxembourg|slovakia|slovenia|bulgaria|cyprus|malta|serbia|ukraine|turkey|israel|united arab emirates|\buae\b|dubai|abu dhabi|saudi|qatar|kuwait|bahrain|oman|egypt|nigeria|kenya|south africa|singapore|malaysia|indonesia|philippines|vietnam|thailand|japan|korea|china|hong kong|taiwan|australia|new zealand|pakistan|bangladesh|sri lanka|nepal|london|berlin|munich|paris|madrid|barcelona|amsterdam|lisbon|dublin|milan|rome|warsaw|prague|vienna|stockholm|copenhagen|zurich|new york|san francisco|seattle|boston|austin|chicago|toronto|vancouver|sydney|melbourne|tokyo|riyadh|doha|,\s*(ca|ny|tx|wa|ma|il|nj|ga|co|fl|va|nc|pa)\b/i;
const REMOTE = /remote|work from home|\bwfh\b|anywhere/i;

/** True for a job outside India that is not remote: hidden from the list and never queued. */
export function isForeignOnsite(location: string): boolean {
  const loc = location || '';
  return !INDIA.test(loc) && FOREIGN.test(loc) && !REMOTE.test(loc);
}
