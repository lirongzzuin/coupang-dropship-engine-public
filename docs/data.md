# 개선용 데이터(가볍게 누적)

나중에 알고리즘이나 가격을 고칠 때 근거로 쓰는 데이터입니다. 별도 저장소 없이 기존 DB에 작은 표 두 개만 추가했고, 큰 기록은 자동으로 정리합니다.

| 표 | 쌓이는 양 | 내용 | 활용 |
|---|---|---|---|
| `daily_metrics` | 하루 × 운영 상품 수(예: 30행/일) | 상품별 하루 판매가·마크업·주문·매출·예상이익(아침 브리핑 때 전날분 기록) | 가격대별 판매 반응, 상품 수명, 요일·계절 패턴 |
| `selection_runs` | 선정 1회 1행 | 검토·통과·등록 수, 탈락 사유 집계(`fails`), 미등록 사유(`skipped`), 그때의 모델 계수(`model`) | 어떤 조건이 후보를 너무 많이 떨어뜨리는지, 계수 변경 전후 비교 |
| `candidates` | 실행당 수백 행 | 후보별 게이트·점수·`signals.demand`(기대 월판매·월이익·요소별 계수)·`family`·`category` | **기대 vs 실제** 비교: 등록된 후보(`listings.candidate_id`)의 실제 주문과 비교해 계수 보정 |
| `orders`, `price_changes`, `market_signals` | 기존 | 주문·가격 변경 이력·키워드 검색량 이력 | |

자동 정리(아침 브리핑 때):
- 탈락 후보: 60일
- 작업 기록: 30일
- 알림: 90일
- 시장 신호: 400일

통과 후보, 주문, 일일 스냅샷은 계속 보관합니다.

## 자주 쓸 질의(예시)
```sql
-- 기대 월판매 대비 실제 판매(모델 보정용)
select c.keyword, l.title, (c.signals->'demand'->>'sales')::float as expected_month,
       count(o.id) as orders, date_part('day', now() - l.listed_at) as days
from listings l join candidates c on c.id = l.candidate_id
left join orders o on o.listing_id = l.id and o.status <> 'CANCELLED'
where l.dry_run = false group by 1,2,3,5 order by orders desc;

-- 최근 선정에서 가장 많이 떨어뜨린 조건
select run_id, at, fails from selection_runs order by at desc limit 10;

-- 가격(마크업)별 하루 판매
select round(markup::numeric, 2) m, avg(orders) from daily_metrics group by 1 order by 1;
```
DB는 Mac 내장(PGlite, `~/dropship/data`)입니다. 분석할 때는 백업 파일(`~/dropship/backups`)을 복사해 따로 열면 운영에 영향이 없습니다.
