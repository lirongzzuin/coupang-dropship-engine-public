# 상품 선정 모델 (selection-model.md)

코드: `server/src/modules/selection/` (`scoring.ts`는 I/O 없는 순수 함수, `service.ts`는 파이프라인). 모든 임계값과 가중치는 settings(`selection.*`)에 있습니다.

## 1. 파이프라인
1. 키워드 = 시드 키워드(설정) ∪ 잘 팔리는 상품의 키워드(최근 14일 주문 3건 이상, 자동 확장)
2. 키워드별 신호 수집(실패하면 해당 신호 없이 진행)
   - 월간 검색량(네이버 검색광고, 절대값)
   - 12주 추세(데이터랩, 상대값)
   - 네이버 쇼핑: 최저가·상품 수·판매처 수
   - 쿠팡 판매량 추정(수동 CSV, 최근 30일)
3. 공급처별 검색(공급가 범위 필터) → 상품 상세 재조회 → 목표 판매가 계산(`pricing.targetPrice`)
4. 하드 게이트 → 점수 → 후보 저장
5. auto 모드: 통과 + 점수 ≥ `autoListMinScore` + 공급처 이미지 재사용 허용 + (`autoListRequiresApiOrder`이면) API 자동 발주 가능 → 상위 `autoListPerRun`개를 자동 등록. 운영 상품 수 상한(`listing.maxActiveListings`)을 지킵니다.

## 2. 하드 게이트(하나라도 실패하면 제외)
| 게이트 | 조건 |
|---|---|
| status / stock | 판매중, 재고 ≥ `minStock`(재고를 모르면 통과) |
| supplyPrice | `minSupplyPrice` ≤ 공급가 ≤ `maxSupplyPrice` (기본 하한 15,000원 — feasibility §2-3) |
| trademark | 상품명·카테고리에 `blockedKeywords`(브랜드·"정품" 등) 없음 |
| category | `blockedCategoryKeywords`(의약·건강기능식품·주류 등 인증/금지) 없음 |
| kc | `kcSensitiveKeywords`(전기·충전·어린이…)에 해당하면 KC 인증번호 또는 면제 정보 필수 |
| profit | 목표가에서 순이익 ≥ `minProfitKrw` 그리고 순이익률 ≥ `minMarginRate` |
| competitive | 목표가 ≤ 시장 최저가 × (1 + `competitiveTolerance`). 시장가를 모르면 `requireMarketPrice`에 따름 |

소프트 게이트(표시만): 이미지 재사용 허용, 고시정보 보유, API 자동 발주 가능 여부.

## 3. 점수
각 구성요소를 0~1로 정규화하고, **값이 있는 요소만** 가중 평균합니다(가중치 `selection.weights`).

| 요소 | 식 |
|---|---|
| demand | log10(월간검색량+1) / 5 |
| trend | (최근4주 평균 − 직전4주 평균) / 직전4주 평균 → [−1,1] → (x+1)/2 |
| competition | 1 − log10(네이버 상품수+1) / 6 |
| priceAdvantage | (시장최저 − 목표가) / 시장최저 × 5 (최저가보다 20% 싸면 1) |
| margin | 순이익률 / 0.3 |
| supplier | 공급처 평점(없으면 0.7) × 0.7 + (자동 발주 가능 ? 0.3 : 0) |
| coupangSales | log10(추정판매량+1) / 4 (기본 가중치 0 — 추정치라 신뢰도 낮음) |

## 4. 운영 루프(`modules/sync`)
- 등록 후 `zeroSaleDays`(14일) 동안 판매 0건 → 하한가로 1회 인하 → 다시 14일 0건 → 판매종료. 다음 선정 주기에 새 후보로 교체됩니다.
- 재보정(향후): 쌓인 `candidates.signals`와 실제 주문 수로 가중치를 회귀 추정하는 배치를 추가할 수 있습니다(데이터 축적 후).
